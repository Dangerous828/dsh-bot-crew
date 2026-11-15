import json,os,re,signal,socket,subprocess,sys,time
HERE='/Users/cpuser/Code/dsh-bot-crew/docs/review/i20'
SERVER=os.path.join(HERE,'probe_server.py')
CLASSES='/tmp/i20/out_cur2:/tmp/i20/harness_cur:/tmp/kotlinc-copy/lib/kotlin-stdlib.jar'
def free_port():
    s=socket.socket();s.bind(('127.0.0.1',0));p=s.getsockname()[1];s.close();return p
def conns(port):
    try:
        out=subprocess.run(['lsof','-nP','-iTCP:%d'%port,'-sTCP:ESTABLISHED'],capture_output=True,text=True,timeout=10).stdout
        return max(0,len([l for l in out.splitlines() if 'ESTABLISHED' in l]))
    except: return -1
def one(name,mode,drip,wait_ms,budget,rounds=1):
    port=free_port()
    srv=subprocess.Popen([sys.executable,SERVER,str(port),mode,'--drip-ms',str(drip)],stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True,bufsize=1)
    ready=srv.stdout.readline()
    if 'ready' not in ready.lower():
        ready+=srv.stdout.readline()
    t=time.time()
    p=subprocess.Popen(['java','-cp',CLASSES,'ProbeHarness2Kt',str(port),'tok',str(wait_ms),str(budget),str(rounds)],stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True)
    try: out,_=p.communicate(timeout=90)
    except subprocess.TimeoutExpired: p.kill();out,_=p.communicate()
    w=time.time()-t; still=conns(port)
    srv.send_signal(signal.SIGKILL);srv.wait()
    lines=[l for l in out.splitlines() if l.startswith('RESULT')]
    print(f"{name[:22]:22} | {budget:6} | {w:6.2f}s | peer={still} | {lines}")
    return {'case':name,'wall':round(w,2),'peer':still,'lines':lines}
cases=[
 ('drip800',"drip",800,15000,1500),
 ('drip100',"drip",100,15000,1500),
 ('hang',"hang",0,15000,1500),
 ('drip200 x3',"drip",200,15000,1500,3),
 ('normal fast',"normal",0,15000,1500),
 ('drip800 prod20s',"drip",800,15000,20000),
]
res=[]
for c in cases:
    name,mode,drip,wait_ms,budget=c[0],c[1],c[2],c[3],c[4]
    rounds=c[5] if len(c)>5 else 1
    res.append(one(name,mode,drip,wait_ms,budget,rounds))
json.dump(res,open('/tmp/deadline_manual.json','w'),ensure_ascii=False,indent=1)
