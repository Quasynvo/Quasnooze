# Optional browser validation: requires Python Playwright + Chromium, not a runtime dependency.
import threading,time,json,tempfile
from pathlib import Path
from http.server import SimpleHTTPRequestHandler,ThreadingHTTPServer
from playwright.sync_api import sync_playwright,expect
root=str(Path(__file__).resolve().parents[1] / 'public')
output=Path(tempfile.mkdtemp(prefix='cosmic-browser-'))
state={'native':{'available':False,'phase':'not-running','mic':False,'busy':False,'recent':[]},'approved':None,'event':threading.Event(),'posts':[],'auth':False}
class Handler(SimpleHTTPRequestHandler):
 def __init__(self,*a,**kw):super().__init__(*a,directory=root,**kw)
 def log_message(self,*a):pass
 def reply(self,obj,code=200):
  self.send_response(code);self.send_header('Content-Type','application/json');self.end_headers();self.wfile.write(json.dumps(obj).encode())
 def do_GET(self):
  if self.path.startswith('/api/'):
   if state['auth'] and (self.headers.get('x-quasnooze-key') or self.headers.get('x-pinch-key'))!='test-only-key':return self.reply({},401)
   return self.reply({'provider':'mock','model':'browser-fixture'} if self.path=='/api/health' else state['native'])
  super().do_GET()
 def do_POST(self):
  body=json.loads(self.rfile.read(int(self.headers.get('content-length','0'))));state['posts'].append((self.path,body))
  if self.path=='/api/approve':state['approved']=body;state['event'].set();return self.reply({'ok':True})
  if self.path=='/api/desktop':return self.reply({'ok':True})
  text=body.get('text','');self.send_response(200);self.send_header('Content-Type','text/event-stream');self.end_headers()
  def send(event,data):
   b=('event: '+event+'\r\ndata: '+json.dumps(data,ensure_ascii=False)+'\r\n\r\n').encode();self.wfile.write(b[:max(1,len(b)//2)]);self.wfile.flush();self.wfile.write(b[max(1,len(b)//2):]);self.wfile.flush()
  if text=='approval please':
   state['event'].clear();send('step',{'type':'approval','id':'fixture-approval','description':'<img src=x onerror=alert(1)> Untrusted action preview'});state['event'].wait(8);send('final',{'text':'Allowed fixture' if state['approved'] and state['approved']['allowed'] else 'Denied fixture'})
  elif text=='broken':send('step',{'type':'status','message':'fixture'});return
  else:
   send('step',{'type':'delta','text':'Hello 🌌'});send('final',{'text':'Hello 🌌 <img src=x onerror=window.injected=1>'})
server=ThreadingHTTPServer(('127.0.0.1',0),Handler);threading.Thread(target=server.serve_forever,daemon=True).start()
base='http://127.0.0.1:'+str(server.server_address[1])
results=[]
def passed(name):results.append(name);print('PASS',name)
with sync_playwright() as p:
 b=p.chromium.launch(headless=True,args=['--no-sandbox']);page=b.new_page(viewport={'width':1440,'height':1000});errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
 page.goto(base+'/cosmic.html?demo=1');expect(page.locator('#connection')).to_contain_text('SCRIPTED');page.locator('#prompt').fill('A test');page.locator('#composer').evaluate('(f)=>f.requestSubmit()');expect(page.locator('.messages')).to_contain_text('Scripted preview:');page.wait_for_timeout(3500);assert not state['posts'];passed('Explicit demo sends no backend request')
 page.locator('#animate').click();expect(page.locator('body')).to_have_attribute('data-state','thinking');expect(page.locator('#send')).to_be_disabled();page.wait_for_timeout(1300);expect(page.locator('body')).to_have_attribute('data-state','speaking');passed('Animated states and input locking during preview');page.wait_for_timeout(2700)
 page.locator('#settings').click();expect(page.locator('#settingsDialog')).to_be_visible();page.locator('#reduceMotion').check();assert page.locator('body').evaluate('(e)=>e.classList.contains("reduced")');page.keyboard.press('Escape');expect(page.locator('#settingsDialog')).not_to_be_visible();passed('Settings dialog, Escape and reduced-motion preference')
 assert not page.evaluate('document.documentElement.scrollWidth > innerWidth');page.screenshot(path=str(output/'desktop-preview.png'),full_page=True);page.set_viewport_size({'width':390,'height':844});assert not page.evaluate('document.documentElement.scrollWidth > innerWidth');page.screenshot(path=str(output/'mobile-preview.png'),full_page=True);passed('Desktop and 390px mobile layout have no horizontal overflow')
 page.set_viewport_size({'width':1440,'height':1000});page.goto(base+'/cosmic.html');expect(page.locator('#connection')).to_contain_text('CONNECTED');expect(page.locator('#talk')).to_be_disabled();passed('No native companion means local microphone control disabled')
 def submit(text):page.locator('#prompt').fill(text);page.locator('#composer').evaluate('(f)=>f.requestSubmit()')
 submit('normal');expect(page.locator('#messages')).to_contain_text('Hello 🌌 <img');assert page.locator('#messages img').count()==0;assert not page.evaluate('Boolean(window.injected)');expect(page.locator('#send')).to_be_enabled();passed('Real fetch/SSE path renders Unicode and untrusted output as text')
 submit('approval please');expect(page.locator('#approval')).to_be_visible();expect(page.locator('body')).to_have_attribute('data-state','approval');assert page.locator('#approval img').count()==0;page.locator('#deny').click();expect(page.locator('#messages')).to_contain_text('Denied fixture');assert state['approved']['allowed'] is False;passed('Explicit denial and untrusted approval text are safe')
 expect(page.locator('#send')).to_be_enabled();submit('approval please');expect(page.locator('#approval')).to_be_visible();page.locator('#allow').click();expect(page.locator('#messages')).to_contain_text('Allowed fixture');assert state['approved']['allowed'] is True;passed('Allow requires a click and sends only the pending ID')
 expect(page.locator('#send')).to_be_enabled();submit('broken');expect(page.locator('#messages')).to_contain_text('backend task may still be running');passed('Interrupted stream is not presented as successful task cancellation')
 state['native']={'available':True,'phase':'speaking','mic':False,'busy':False,'recent':[]};expect(page.locator('body')).to_have_attribute('data-state','speaking',timeout=5000);expect(page.locator('#stopVoice')).to_be_enabled();page.locator('#stopVoice').click();page.wait_for_timeout(150);assert state['posts'][-1][1]=={'control':'stop-voice'};passed('Native speaking state and stop-voice control use existing desktop API')
 state['native']={'available':False,'phase':'not-running','mic':False,'busy':False,'recent':[]};state['auth']=True;page.goto(base+'/cosmic.html');expect(page.locator('#send')).to_be_disabled();page.locator('#settings').click();page.locator('#accessKey').fill('test-only-key');page.locator('#connect').click();expect(page.locator('#connection')).to_contain_text('CONNECTED');assert page.evaluate('localStorage.length')==0;assert page.evaluate('sessionStorage.length')==0;assert 'key=' not in page.url;passed('Authentication remains memory-only and can reconnect')
 assert not errors,errors;passed('No browser JavaScript exceptions across all scenarios');b.close()
server.shutdown();open(output/'results.json','w').write(json.dumps(results,indent=2));print(len(results),'browser scenarios passed')

print("Browser artifacts:",output)
