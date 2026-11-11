#!/usr/bin/env python3
"""Real TCP integration test for dynamic nested-group chains in patched Mihomo."""
import http.client, json, os, select, socket, socketserver, subprocess, sys, tempfile, threading, time
from pathlib import Path
from urllib.parse import quote

records = []
lock = threading.Lock()
def rec(name):
    with lock: records.append(name)
def exact(s,n):
    data=b''
    while len(data)<n:
        part=s.recv(n-len(data))
        if not part: raise EOFError()
        data+=part
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
            elif atyp==4: host=socket.inet_ntop(socket.AF_INET6,exact(c,16))
            else: raise ValueError('address')
            port=int.from_bytes(exact(c,2),'big')
            rec(self.server.label)
            with socket.create_connection((host,port),timeout=5) as remote:
                c.sendall(b'\x05\x00\x00\x01\x00\x00\x00\x00\x00\x00')
                c.settimeout(None); remote.settimeout(None)
                while True:
                    readable,_,_=select.select([c,remote],[],[],8)
                    if not readable: break
                    for source in readable:
                        data=source.recv(65536)
                        if not data: return
                        (remote if source is c else c).sendall(data)
        except (OSError, EOFError): pass
class Http(socketserver.BaseRequestHandler):
    def handle(self):
        self.request.recv(4096)
        self.request.sendall(b'HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nOK')
class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address=True
    daemon_threads=True

def server(handler,label):
    s=Server(('127.0.0.1',0),handler); s.label=label
    threading.Thread(target=s.serve_forever,daemon=True).start(); return s

def free_port():
    with socket.socket() as s:
        s.bind(('127.0.0.1',0)); return s.getsockname()[1]

def api(port,group,node):
    conn=http.client.HTTPConnection('127.0.0.1',port,timeout=3)
    conn.request('PUT','/proxies/'+quote(group,safe=''),json.dumps({'name':node}),{'Content-Type':'application/json'})
    response=conn.getresponse(); body=response.read(); conn.close()
    if response.status != 204: raise RuntimeError((group,node,response.status,body))

def request(port,target):
    with socket.create_connection(('127.0.0.1',port),timeout=6) as s:
        s.sendall(f'GET http://127.0.0.1:{target}/ HTTP/1.1\r\nHost: 127.0.0.1:{target}\r\nConnection: close\r\n\r\n'.encode())
        s.settimeout(6); data=b''
        while True:
            part=s.recv(4096)
            if not part: break
            data+=part
        return data

def run_case(binary, generator, provider_case):
    servers=[server(Socks,n) for n in ('A1','A2','B1','B2')]; target=server(Http,'http')
    p={s.label:s.server_address[1] for s in servers}; mixed=free_port(); controller=free_port()
    config=f'''mixed-port: {mixed}
allow-lan: false
mode: rule
log-level: warning
external-controller: 127.0.0.1:{controller}
proxies:
  - {{name: A1, type: socks5, server: 127.0.0.1, port: {p['A1']}}}
  - {{name: A2, type: socks5, server: 127.0.0.1, port: {p['A2']}}}
  - {{name: B1, type: socks5, server: 127.0.0.1, port: {p['B1']}}}
  - {{name: B2, type: socks5, server: 127.0.0.1, port: {p['B2']}}}
proxy-groups:
  - {{name: Rule, type: select, proxies: [A, B]}}
  - {{name: A, type: select, proxies: [A1, A2]}}
  - {{name: B, type: select, proxies: [Nested, B2, DIRECT]}}
  - {{name: Nested, type: select, proxies: [B1]}}
rules: ["MATCH,Rule"]
'''
    with tempfile.TemporaryDirectory() as d:
        if provider_case:
            # Move the B nodes into a real file-backed subscription. Both the
            # source provider and its generated clone read the same file.
            Path(d, 'nodes.yaml').write_text(f"proxies:\n  - {{name: B1, type: socks5, server: 127.0.0.1, port: {p['B1']}}}\n  - {{name: B2, type: socks5, server: 127.0.0.1, port: {p['B2']}}}\n", encoding='utf-8')
            config=config.replace(f"  - {{name: B1, type: socks5, server: 127.0.0.1, port: {p['B1']}}}\n", '').replace(f"  - {{name: B2, type: socks5, server: 127.0.0.1, port: {p['B2']}}}\n", '')
            config=config.replace('proxy-groups:', 'proxy-providers:\n  airport: {type: file, path: ./nodes.yaml}\nproxy-groups:')
            config=config.replace('proxies: [Nested, B2, DIRECT]', 'proxies: [Nested, DIRECT], use: [airport]')
            config=config.replace('proxies: [B1]', 'use: [airport]')
        generated=subprocess.run([generator],input=config,text=True,encoding="utf-8",capture_output=True,check=True)
        chain=generated.stderr.strip().splitlines()[-1]
        Path(d,'config.yaml').write_text(generated.stdout,encoding='utf-8')
        process=subprocess.Popen([binary,'-d',d,'-f',str(Path(d,'config.yaml'))],stdout=subprocess.DEVNULL,stderr=subprocess.PIPE)
        try:
            for _ in range(100):
                if process.poll() is not None: raise RuntimeError(process.stderr.read().decode(errors='replace'))
                try:
                    with socket.create_connection(('127.0.0.1',controller),timeout=.2): break
                except OSError: time.sleep(.1)
            else: raise RuntimeError('core did not start')
            api(controller,'Rule',chain)
            for a,b,expected in [('A1','Nested',['A1','B1']),('A2','Nested',['A2','B1']),('A2','B2',['A2','B2']),('A1','B2',['A1','B2']),('A1','DIRECT',['A1'])]:
                api(controller,'A',a); api(controller,'B',b)
                with lock: records.clear()
                response=request(mixed,target.server_address[1])
                with lock: actual=records[:]
                assert b'200 OK' in response and actual==expected, (a,b,expected,actual,response[:300])
                print('PASS',a,b,' => ',' -> '.join(actual),flush=True)
            api(controller,'Rule','A')
            with lock: records.clear()
            assert b'200 OK' in request(mixed,target.server_address[1])
            with lock: assert records==['A1'], records
            print('PASS unrelated selection stays unchanged',flush=True)
        finally:
            process.terminate()
            try: process.wait(timeout=5)
            except subprocess.TimeoutExpired: process.kill(); process.wait()
            for s in servers+[target]: s.shutdown(); s.server_close()
def main():
    binary=str(Path(sys.argv[1]).resolve())
    generator=str(Path(sys.argv[2]).resolve())
    for provider_case in (False, True):
        print('Testing', 'provider' if provider_case else 'static', 'nodes', flush=True)
        run_case(binary, generator, provider_case)
if __name__=='__main__': main()
