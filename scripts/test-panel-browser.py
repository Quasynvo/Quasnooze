# Optional Python Playwright + Chromium: a disposable mocked API, no native host or tools.
import threading,json,tempfile
from pathlib import Path
from http.server import SimpleHTTPRequestHandler,ThreadingHTTPServer
from playwright.sync_api import sync_playwright,expect
root=Path(__file__).resolve().parents[1];out=Path(tempfile.mkdtemp(prefix='quasnooze-panels-'))
class H(SimpleHTTPRequestHandler):
 def __init__(self,*a,**kw):super().__init__(*a,directory=str(root/'public'),**kw)
 def log_message(self,*a):pass
s=ThreadingHTTPServer(('127.0.0.1',0),H);threading.Thread(target=s.serve_forever,daemon=True).start();base=f'http://127.0.0.1:{s.server_port}'
health={'provider':'mock','model':'UI fixture — not a live model','owner':'You','memoryFacts':0,'workspace':[],'channels':{},'uptimeSeconds':0}
native={'available':False,'phase':'not-running','mic':False,'busy':False,'recent':[]}
with sync_playwright() as p:
 b=p.chromium.launch();page=b.new_page(viewport={'width':1568,'height':1000});errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
 def api(route):
  path=route.request.url.split('/api/',1)[1]
  if path=='events':return route.fulfill(status=200,content_type='text/event-stream',body=': browser fixture\n\n')
  result=health if path=='health' else native if path=='desktop' else [] if path=='sessions' else {'facts':[]} if path=='memory' else {}
  route.fulfill(status=200,content_type='application/json',body=json.dumps(result))
 page.route('**/api/**',api)
 page.goto(base+'/desktop.html');expect(page.locator('#connection')).to_have_text('LOCAL SERVICE CONNECTED');expect(page.locator('#micState')).to_have_text('OFF');assert not page.evaluate('document.documentElement.scrollWidth>innerWidth');assert page.locator('a[href="/cosmic.html"]').count()>0;page.screenshot(path=str(out/'command-deck.png'),full_page=True)
 page.goto(base+'/index.html');expect(page.locator('#liveText')).to_have_text('online');page.locator('#newChat').click();expect(page.locator('#thread')).to_contain_text('same orbit');assert page.locator('#thread .who img').count()==1;assert page.locator('a[href="/cosmic.html"]').count()>0;page.screenshot(path=str(out/'Quasnooze-Advanced-Chat.png'),full_page=True)
 assert not errors,errors;b.close()
s.shutdown();print('PASS 2 panel scenarios: updated command deck and advanced chat, canonical mark renders, session reset works, companion links present, no browser JavaScript exceptions. Mocked API fixture only; no AI/audio/tools/native host.')

print("Browser artifacts:",out)
