import torch, time
torch.backends.cuda.matmul.allow_tf32 = True
a = torch.randn(4096, 4096, device="cuda"); b = torch.randn(4096, 4096, device="cuda")
for _ in range(3): c = a@b
torch.cuda.synchronize(); t0=time.time(); n=20
for _ in range(n): c = a@b
torch.cuda.synchronize(); dt=(time.time()-t0)/n
print("fp32 4096 matmul: %.1f ms  %.1f TFLOPS" % (dt*1000, 2*4096**3/dt/1e12))
ah, bh = a.half(), b.half()
for _ in range(3): ch = ah@bh
torch.cuda.synchronize(); t0=time.time()
for _ in range(n): ch = ah@bh
torch.cuda.synchronize(); dt=(time.time()-t0)/n
print("fp16 4096 matmul: %.1f ms  %.1f TFLOPS" % (dt*1000, 2*4096**3/dt/1e12))
print("mem", torch.cuda.memory_allocated()//2**20, "MB")
