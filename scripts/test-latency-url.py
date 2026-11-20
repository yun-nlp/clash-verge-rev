#!/usr/bin/env python3
"""Exercise URL-test selection after changing UI URL, using a real Mihomo core."""
import http.client, json, select, socket, socketserver, subprocess, sys, tempfile, threading, time
from pathlib import Path

def exact(s,n):
    data=b''
    while len(data)<n:
        p=s.recv(n-len(data))
        if not p: raise EOFError()
        data+=p
    return data
class Socks(socketserver.BaseRequestHandler):
    def handle(self):
        c=self.request
        try:
            version,n=exact(c,2); assert version==5
            exact(c,n); c.sendall(b'\x05\x00')
            version,cmd,_,atyp=exact(c,4); assert (version,cmd)==(5,1)
            if atyp==1: host=socket.inet_ntoa(exact(c,4))
            elif atyp==3: host=exact(c,exact(c,1)[0]).decode()
            else: raise ValueError('address type')
            port=int.from_bytes(exact(c,2),'big')
            if (self.server.label=='A' and port==self.server.slow_for_a) or (self.server.label=='B' and port==self.server.slow_for_b): time.sleep(.4)
            with socket.create_connection((host,port),timeout=5) as remote:
                c.sendall(b'\x05\x00\x00\x01\x00\x00\x00\x00\x00\x00')
                c.settimeout(None); remote.settimeout(None)
                while True:
                    readable,_,_=select.select([c,remote],[],[],8)
                    if not readable: return
                    for source in readable:
                        data=source.recv(65536)
                        if not data: return
                        (remote if source is c else c).sendall(data)
        except (OSError, EOFError): pass
class Http(socketserver.BaseRequestHandler):
    def handle(self):
        self.request.recv(4096)
        self.request.sendall(b'HTTP/1.1 204 No Content\r\nContent-Length: 0\r\nConnection: close\r\n\r\n')
class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address=True
    daemon_threads=True

def server(handler,label):
    s=Server(('127.0.0.1',0),handler); s.label=label
    threading.Thread(target=s.serve_forever,daemon=True).start(); return s

def free_port():
    with socket.socket() as s:
        s.bind(('127.0.0.1',0)); return s.getsockname()[1]

def call(port,method,path,body=None):
    c=http.client.HTTPConnection('127.0.0.1',port,timeout=10)
    c.request(method,path, None if body is None else json.dumps(body), {'Content-Type':'application/json'})
    r=c.getresponse(); data=r.read(); c.close()
    if r.status not in (200,204): raise RuntimeError((r.status,data))
    return json.loads(data) if data else None

def run_case(core, generator, provider_case):
    t1,t2=server(Http,'test1'),server(Http,'test2'); a,b=server(Socks,'A'),server(Socks,'B')
    for s in (a,b):
        s.slow_for_a=(t1 if provider_case else t2).server_address[1]
        s.slow_for_b=(t2 if provider_case else t1).server_address[1]
    url1=f'http://127.0.0.1:{t1.server_address[1]}/generate_204'
    url2=f'http://127.0.0.1:{t2.server_address[1]}/generate_204'
    port=free_port()
    base=f'''mixed-port: {free_port()}
external-controller: 127.0.0.1:{port}
mode: rule
log-level: warning
proxies:
  - {{name: A, type: socks5, server: 127.0.0.1, port: {a.server_address[1]}}}
  - {{name: B, type: socks5, server: 127.0.0.1, port: {b.server_address[1]}}}
proxy-groups:
  - {{name: G, type: url-test, url: 'http://127.0.0.1:9/old', interval: 1, lazy: false, tolerance: 0, proxies: [A, B]}}
rules: ["MATCH,G"]
'''
    if provider_case:
        base=base.replace(f"proxies:\n  - {{name: A, type: socks5, server: 127.0.0.1, port: {a.server_address[1]}}}\n  - {{name: B, type: socks5, server: 127.0.0.1, port: {b.server_address[1]}}}\n", f"proxy-providers:\n  nodes:\n    type: inline\n    health-check: {{enable: false, url: '{url1}'}}\n    payload:\n      - {{name: A, type: socks5, server: 127.0.0.1, port: {a.server_address[1]}}}\n      - {{name: B, type: socks5, server: 127.0.0.1, port: {b.server_address[1]}}}\n")
        base=base.replace('interval: 1, lazy: false, tolerance: 0, proxies: [A, B]', 'lazy: false, tolerance: 0, use: [nodes]')
    first,second=('B','A') if provider_case else ('A','B')
    def generated(global_url, group_url):
        return subprocess.run([generator,'--url-test',global_url,group_url],input=base,text=True,encoding='utf-8',capture_output=True,check=True).stdout
    def check(expected_url, expected_node):
        deadline=time.time()+25
        while time.time()<deadline:
            info=call(port,'GET','/proxies/G')
            if info['testUrl']==expected_url and info['now']==expected_node:
                print('PASS test URL',expected_url,'selected',expected_node,flush=True); return
            time.sleep(.3)
        raise AssertionError(info)
    with tempfile.TemporaryDirectory() as d:
        config=Path(d,'config.yaml'); config.write_text(generated(url1,''),encoding='utf-8')
        proc=subprocess.Popen([core,'-d',d,'-f',str(config)],stdout=subprocess.DEVNULL,stderr=subprocess.PIPE)
        try:
            for _ in range(100):
                if proc.poll() is not None: raise RuntimeError(proc.stderr.read().decode(errors='replace'))
                try: call(port,'GET','/configs'); break
                except OSError: time.sleep(.1)
            else: raise RuntimeError('core did not start')
            check(url1,first)
            # A group-specific UI URL overrides the global one on config reload.
            call(port,'PUT','/configs?force=true',{'payload':generated(url1,url2)})
            check(url2,second)
            # Clearing the group field returns to the configured global default.
            call(port,'PUT','/configs?force=true',{'payload':generated(url1,'')})
            check(url1,first)
        finally:
            proc.terminate()
            try: proc.wait(timeout=5)
            except subprocess.TimeoutExpired: proc.kill(); proc.wait()
            for s in (a,b,t1,t2): s.shutdown(); s.server_close()
def main():
    core=str(Path(sys.argv[1]).resolve()); generator=str(Path(sys.argv[2]).resolve())
    for provider_case in (False,True):
        print('Testing', 'provider (health check initially disabled)' if provider_case else 'static', flush=True)
        run_case(core,generator,provider_case)
if __name__=='__main__': main()
