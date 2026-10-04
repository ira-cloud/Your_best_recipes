#!/usr/bin/env python3
"""Голосовой блокнот поверх всех окон.

Маленькое окно, которое всегда сверху: нажимаешь горячую клавишу в любом
приложении -> говоришь -> снова клавиша -> текст появляется в окне
(и, если включено, сразу вставляется туда, где стоит курсор).
Распознавание локальное (faster-whisper), интернет нужен только
для первой загрузки модели.
"""
import queue
import sys
import threading
import time
import tkinter as tk

import numpy as np
import sounddevice as sd
from faster_whisper import WhisperModel
from pynput import keyboard

# ---- настройки ----
MODEL_SIZE = "small"        # tiny / base / small / medium / large-v3 (точнее, но медленнее)
LANGUAGE = "ru"             # None = автоопределение языка
HOTKEY = "<ctrl>+<alt>+<space>"   # старт/стоп записи из любого приложения
SAMPLE_RATE = 16000
IS_MAC = sys.platform == "darwin"


class VoiceOverlay:
    def __init__(self):
        self.model = None
        self.recording = False
        self.frames = []
        self.stream = None
        self.started_at = 0.0
        self.events = queue.Queue()   # события из фоновых потоков -> GUI
        self.kb = keyboard.Controller()

        self.root = tk.Tk()
        self.root.title("Голос → текст")
        self.root.geometry("420x300+40+40")
        self.root.attributes("-topmost", True)
        self.root.attributes("-alpha", 0.93)

        bar = tk.Frame(self.root)
        bar.pack(fill="x", padx=6, pady=(6, 2))
        self.rec_btn = tk.Button(bar, text="● Запись", width=10, command=self.toggle)
        self.rec_btn.pack(side="left")
        tk.Button(bar, text="Копировать", command=self.copy_all).pack(side="left", padx=4)
        tk.Button(bar, text="Очистить", command=lambda: self.text.delete("1.0", "end")).pack(side="left")

        self.autopaste = tk.BooleanVar(value=True)
        self.on_top = tk.BooleanVar(value=True)
        opts = tk.Frame(self.root)
        opts.pack(fill="x", padx=6)
        tk.Checkbutton(opts, text="Вставлять в активное окно", variable=self.autopaste).pack(side="left")
        tk.Checkbutton(opts, text="Поверх окон", variable=self.on_top,
                       command=lambda: self.root.attributes("-topmost", self.on_top.get())).pack(side="left")

        body = tk.Frame(self.root)
        body.pack(fill="both", expand=True, padx=6, pady=4)
        scroll = tk.Scrollbar(body)
        scroll.pack(side="right", fill="y")
        self.text = tk.Text(body, wrap="word", font=("Segoe UI", 12), yscrollcommand=scroll.set)
        self.text.pack(side="left", fill="both", expand=True)
        scroll.config(command=self.text.yview)

        self.status = tk.Label(self.root, anchor="w", fg="#555",
                               text="Загружаю модель распознавания…")
        self.status.pack(fill="x", padx=6, pady=(0, 6))

        threading.Thread(target=self._load_model, daemon=True).start()
        self.hotkeys = keyboard.GlobalHotKeys({HOTKEY: lambda: self.events.put(("toggle", None))})
        self.hotkeys.start()
        self.root.after(100, self._poll)

    # ---- фоновые задачи ----
    def _load_model(self):
        try:
            model = WhisperModel(MODEL_SIZE, device="cpu", compute_type="int8")
            self.events.put(("model", model))
        except Exception as e:
            self.events.put(("error", f"Не удалось загрузить модель: {e}"))

    def _transcribe(self, audio):
        try:
            segments, _ = self.model.transcribe(audio, language=LANGUAGE, vad_filter=True, beam_size=5)
            self.events.put(("text", " ".join(s.text.strip() for s in segments).strip()))
        except Exception as e:
            self.events.put(("error", f"Ошибка распознавания: {e}"))

    def _audio_callback(self, indata, frames, time_info, status):
        self.frames.append(indata.copy())

    # ---- GUI-поток ----
    def _poll(self):
        while not self.events.empty():
            kind, data = self.events.get()
            if kind == "toggle":
                self.toggle()
            elif kind == "model":
                self.model = data
                self.status.config(text=f"Готово. {HOTKEY} — начать/закончить запись.")
            elif kind == "text":
                self._on_text(data)
            elif kind == "error":
                self.status.config(text=data)
        if self.recording:
            self.status.config(text=f"● Идёт запись… {time.time() - self.started_at:.0f} с")
        self.root.after(100, self._poll)

    def toggle(self):
        if self.recording:
            self.stop()
        else:
            self.start()

    def start(self):
        if self.model is None:
            self.status.config(text="Модель ещё загружается, подождите…")
            return
        self.frames = []
        try:
            self.stream = sd.InputStream(samplerate=SAMPLE_RATE, channels=1, dtype="float32",
                                         callback=self._audio_callback)
            self.stream.start()
        except Exception as e:
            self.status.config(text=f"Микрофон недоступен: {e}")
            return
        self.recording = True
        self.started_at = time.time()
        self.rec_btn.config(text="■ Стоп", fg="red")

    def stop(self):
        self.recording = False
        self.stream.stop()
        self.stream.close()
        self.rec_btn.config(text="● Запись", fg="black")
        if not self.frames:
            self.status.config(text="Пустая запись.")
            return
        audio = np.concatenate(self.frames)[:, 0]
        self.status.config(text="Распознаю…")
        threading.Thread(target=self._transcribe, args=(audio,), daemon=True).start()

    def _on_text(self, text):
        if not text:
            self.status.config(text="Речь не распознана.")
            return
        self.text.insert("end", text + "\n")
        self.text.see("end")
        self.status.config(text=f"Готово. {HOTKEY} — новая запись.")
        # вставляем в чужое приложение, только если фокус не в нашем окне
        if self.autopaste.get() and self.root.focus_displayof() is None:
            self._set_clipboard(text + " ")
            self.root.after(80, self._paste)

    def _paste(self):
        mod = keyboard.Key.cmd if IS_MAC else keyboard.Key.ctrl
        with self.kb.pressed(mod):
            self.kb.press("v")
            self.kb.release("v")

    def _set_clipboard(self, text):
        self.root.clipboard_clear()
        self.root.clipboard_append(text)
        self.root.update()

    def copy_all(self):
        self._set_clipboard(self.text.get("1.0", "end").strip())
        self.status.config(text="Весь текст скопирован в буфер обмена.")

    def run(self):
        self.root.mainloop()


if __name__ == "__main__":
    VoiceOverlay().run()
