import soundfile as sf
for n in ["tts_003","tts_013","tts_038","tts_048","tts_001"]:
    info = sf.info(rf"C:\dsh-qq\dafiyu-voice\samples\{n}.mp3")
    print(n, info.samplerate, info.channels, round(info.duration,2), info.format, info.subtype)
