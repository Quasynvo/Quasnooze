// Optional developer check: requires Playwright, not a runtime dependency.
// Use a disposable, loopback mock service with no native companion or Ollama.
const {chromium}=require('playwright');
const assert=require('node:assert/strict');
(async()=>{
 const browser=await chromium.launch({headless:true});
 const page=await browser.newPage({viewport:{width:1568,height:1000}});
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(process.env.PINCH_UI_BASE || 'http://127.0.0.1:7777/');
 await page.getByText('LOCAL SERVICE CONNECTED',{exact:true}).waitFor();
 assert.equal(await page.locator('#micState').textContent(),'OFF');
 assert.match(await page.locator('#notice').textContent(),/not running/);
 await page.locator('#command').fill('what time is it');await page.locator('#runButton').click();
 await page.waitForFunction(()=>document.querySelector('#result').textContent.startsWith('It is'));
 assert.match(await page.locator('#resultKind').textContent(),/NO LLM/);
 await page.locator('#modelButton').click();await page.locator('#modelFeedback').getByText(/no available models|unreachable/).waitFor();
 assert.equal(await page.locator('#saveModel').isDisabled(),true);
 await page.locator('[data-close="modelDialog"]').click();
 await page.locator('#nativeHelp').click();assert.equal(await page.locator('#nativeDialog').isVisible(),true);
 await page.locator('[data-close="nativeDialog"]').click();
 for(const width of [1568,1024,768,390]){
  await page.setViewportSize({width,height:1000});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,'horizontal overflow at '+width);
 }
 await page.setViewportSize({width:1568,height:1000});
 if(process.env.PINCH_UI_SCREENSHOT) await page.screenshot({path:process.env.PINCH_UI_SCREENSHOT,fullPage:true});
 const xss=await browser.newPage({viewport:{width:1200,height:900}});
 await xss.route('**/api/desktop',r=>r.fulfill({json:{available:false,mic:false,phase:'attention',text:'<img src=x onerror="window.INJECTED=1">',lastMs:1,recent:[{command:'<script>window.INJECTED=1</script>',ok:false,ms:1}]}}));
 await xss.goto(process.env.PINCH_UI_BASE || 'http://127.0.0.1:7777/');await xss.getByText('LOCAL SERVICE CONNECTED',{exact:true}).waitFor();
 assert.equal(await xss.evaluate(()=>window.INJECTED),undefined);
 assert.match(await xss.locator('#result').textContent(),/<img/);
 assert.deepEqual(errors,[]);
 console.log('PASS: real backend clock fast path; native-unavailable state; model failure; dialogs; 1568/1024/768/390 layouts; text-only XSS rendering; no page errors. Screenshot is a real Linux/mock-service UI, not proof of Windows voice.');
 await browser.close();
})().catch(e=>{console.error(e);process.exitCode=1;});
