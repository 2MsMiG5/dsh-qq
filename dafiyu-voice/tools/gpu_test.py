import torch, time
print("torch", torch.__version__, "cuda", torch.version.cuda, "cudnn", torch.backends.cudnn.version())
print("is_available", torch.cuda.is_available())
print("device_count", torch.cuda.device_count())
if torch.cuda.is_available():
    print("name", torch.cuda.get_device_name(0))
    cc = torch.cuda.get_device_capability(0)
    print("capability", cc, "-> sm_%d%d" % cc)
    print("total VRAM MB", round(torch.cuda.get_device_properties(0).total_memory/1024/1024))
    print("arch list", torch.cuda.get_arch_list())
    a = torch.randn(2048, 2048, device="cuda")
    b = torch.randn(2048, 2048, device="cuda")
    torch.cuda.synchronize(); t0=time.time()
    for _ in range(10): c = a @ b
    torch.cuda.synchronize(); dt=(time.time()-t0)/10
    print("matmul fp32 ok, %0.2f ms/iter, checksum %0.4f" % (dt*1000, float(c.sum())))
    ah = a.half(); bh = b.half()
    torch.cuda.synchronize(); t0=time.time()
    for _ in range(10): ch = ah @ bh
    torch.cuda.synchronize(); dt=(time.time()-t0)/10
    print("matmul fp16 ok, %0.2f ms/iter, checksum %0.4f" % (dt*1000, float(ch.float().sum())))
    print("peak alloc MB", round(torch.cuda.max_memory_allocated()/1024/1024))
    print("device of result:", ch.device)
