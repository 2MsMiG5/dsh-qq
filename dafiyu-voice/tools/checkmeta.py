import zipfile, sys
p = r"C:\dsh-qq\dafiyu-voice\downloads\wheels\transformers-4.52.1-py3-none-any.whl"
with zipfile.ZipFile(p) as z:
    m = [n for n in z.namelist() if n.endswith('METADATA')][0]
    txt = z.read(m).decode()
for line in txt.splitlines():
    if line.startswith('Requires-Dist') and ('huggingface' in line or 'tokenizers' in line or 'numpy' in line):
        print(line)
print('---- hub 2.3.0 requires ----')
p2 = r"C:\dsh-qq\dafiyu-voice\downloads\wheels\huggingface_hub-2.3.0-py3-none-any.whl"
with zipfile.ZipFile(p2) as z:
    m = [n for n in z.namelist() if n.endswith('METADATA')][0]
    txt = z.read(m).decode()
for line in txt.splitlines():
    if line.startswith('Requires-Dist') or line.startswith('Requires-Python'):
        print(line)
