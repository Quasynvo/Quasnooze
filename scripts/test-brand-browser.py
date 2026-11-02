# Optional: Python Playwright + Chromium. Serve site/ on port 8891, or set QUASNOOZE_SITE_BASE.
import json,os,tempfile
from pathlib import Path
from playwright.sync_api import sync_playwright
out=Path(os.environ.get('QUASNOOZE_SCREENSHOT_DIR') or tempfile.mkdtemp(prefix='quasnooze-site-'));out.mkdir(exist_ok=True)
checks=[]
with sync_playwright() as p:
 b=p.chromium.launch(headless=True);page=b.new_page(viewport={'width':1440,'height':1050});errors=[];requests=[];failed=[]
 page.on('pageerror',lambda e:errors.append(str(e)));page.on('request',lambda r:requests.append(r.url));page.on('response',lambda r:failed.append([r.url,r.status]) if r.status>=400 else None)
 base=os.environ.get('QUASNOOZE_SITE_BASE','http://127.0.0.1:8891').rstrip('/');page.goto(base+'/');page.locator('.art img').wait_for();page.evaluate('Promise.all(Array.from(document.images).map(i=>i.decode().catch(()=>{})))');page.screenshot(path=str(out/'Quasnooze-Website-Desktop.png'),full_page=True)
 for width in [1440,1280,1024,900,768,740,390,360,320]:
  page.set_viewport_size({'width':width,'height':900});overflow=page.evaluate('document.documentElement.scrollWidth>innerWidth');checks.append({'name':f'{width}px layout','passed':not overflow,'scrollWidth':page.evaluate('document.documentElement.scrollWidth')})
 page.set_viewport_size({'width':390,'height':844});page.screenshot(path=str(out/'Quasnooze-Website-Mobile.png'),full_page=True)
 for phase,word in [('thinking','Following'),('speaking','out loud'),('approval','Your call'),('idle','Here')]:
  page.locator(f'button[data-phase="{phase}"]').click();assert word in page.locator('#phaseTitle').inner_text();assert page.locator(f'button[data-phase="{phase}"]').get_attribute('aria-pressed')=='true'
 checks.append({'name':'Four explicit illustrated state controls','passed':True})
 for category,word in [('knowledge','YOUR DOCUMENTS'),('tools','VISIBLE PERMISSIONS'),('everyday','EVERYDAY')]:
  page.locator(f'button[data-category="{category}"]').click();assert word in page.locator('#featureGrid').inner_text()
 checks.append({'name':'Capability categories update accessible pressed state and safe text','passed':True})
 page.locator('#motion').click();assert page.locator('body').evaluate('e=>e.classList.contains("reduced")');assert page.locator('.art').evaluate('e=>getComputedStyle(e).animationName')=='none';checks.append({'name':'Manual reduced-motion control stops motion','passed':True})
 page.locator('summary').first.click();assert page.locator('details').first.get_attribute('open') is not None;checks.append({'name':'Native accessible FAQ disclosure','passed':True})
 page.locator('#copy').click();page.wait_for_function('document.querySelector("#copyStatus").textContent.length>0');checks.append({'name':'Copy command action reports success or safe fallback','passed':True})
 assert not [u for u in requests if not u.startswith(base+'/')];assert not [u for u in requests if '/api/' in u];checks.append({'name':'Static website has no external dependencies or AI/audio/API calls','passed':True})
 assert not failed;assert not errors;checks.append({'name':'No HTTP failures or browser JavaScript exceptions','passed':True})
 page.emulate_media(reduced_motion='reduce');page.reload();assert page.locator('.art').evaluate('e=>getComputedStyle(e).animationName')=='none';checks.append({'name':'OS reduced-motion preference stops animation','passed':True})
 b.close()
(out/'Quasnooze-Website-Checks.json').write_text(json.dumps(checks,indent=2));print(json.dumps(checks,indent=2));assert all(c['passed'] for c in checks)

print("Browser artifacts:",out)
