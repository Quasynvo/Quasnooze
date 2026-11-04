'use strict';
const $ = id => document.getElementById(id);
const queryKey = new URLSearchParams(location.search).get('key');
let key = queryKey || sessionStorage.getItem('pinch.desktop.key') || localStorage.getItem('pinch.key') || '';
if (queryKey) { sessionStorage.setItem('pinch.desktop.key', queryKey); history.replaceState(null, '', location.pathname); }
let current = {}, approvalId = '', approvalSubmitting = false, permissionFocusRequest = '', lastModel = '', refreshing = false;
const headers = () => ({'content-type':'application/json', ...(key ? {'x-quasnooze-key':key} : {})});
async function api(path, body) {
 let response;
 try { response = await fetch(path, {method:body === undefined ? 'GET':'POST', headers:headers(), ...(body === undefined ? {signal:AbortSignal.timeout(5000)} : {}), ...(body === undefined ? {} : {body:JSON.stringify(body)})}); }
 catch (err) { throw Error((err.name === 'TimeoutError' ? 'Quasnooze did not respond in time.' : 'Cannot reach the Quasnooze service at '+location.origin+'.')+' Keep npm run desktop running and reopen Deck from the native Windows widget.'); }
 if (response.status === 401) { if (!$('keyDialog').open) $('keyDialog').showModal(); throw Error('Enter this instance’s key to connect.'); }
 const data = await response.json(); if (!response.ok) throw Error(data.error || 'The request was refused.'); return data;
}
function setText(id, text) { if ($(id).textContent !== text) $(id).textContent = text; }
function toast(text) { $('toast').textContent=text; $('toast').hidden=false; clearTimeout(toast.timer); toast.timer=setTimeout(()=>$('toast').hidden=true,5000); }
const labels = {starting:['Starting the Windows host.','Waiting for its ready event; microphone is off.'],recovering:['Companion recovery in progress.','Reconnects start muted. Interrupted side-effect outcomes are unknown; nothing is replayed.'],unavailable:['Companion unavailable.','Automatic retries stopped. Inspect interrupted actions, then explicitly Retry companion.'],'not-running':['Desktop is not connected.','Run the Windows host for local wake listening, spoken replies and desktop actions.'], muting:['Stopping the local microphone.','Waiting for Windows to confirm release; input status is not yet off.'], muted:['Here. With the microphone off.','Enable local wake in the native widget when you want hands-free help.'], armed:['Call me when you need me.','Say “Hey Quasnooze”, pause for LISTENING, then give one request.'], listening:['I’m listening.','One request at a time. Local Windows speech recognition is active.'], working:['Working on your request.','Microphone paused while the request runs. Common actions skip model inference.'], approval:['Your call. Not mine.','Review the exact action below or in the Windows widget. Voice cannot approve it.'], speaking:['Here’s what happened.','Local Windows speech is reading the result. Stop voice does not cancel a running task.'], ready:['Done. Still here.','See the result below. You remain in control of the next action.'], attention:['Something needs attention.','Read the actual error below. No fake offline conversation or automatic cloud fallback.'], reminder:['A little nudge.','Your reminder is here.']};
function publishMotion(state) { if (typeof CustomEvent === 'function' && typeof globalThis.dispatchEvent === 'function') globalThis.dispatchEvent(new CustomEvent('quasnooze:motion', {detail:state})); }
function render(state) {
 publishMotion(state);
 $('retryButton').disabled=false;
 current=state; const phase=state.phase || 'not-running', label=labels[phase] || labels.ready;
 $('presence').dataset.phase=phase; $('phase').textContent=phase.replaceAll('-',' ').toUpperCase(); $('presenceTitle').textContent=label[0]; $('presenceCopy').textContent=label[1];
 setText('micState', state.micUnknown ? 'UNKNOWN' : (state.mic ? 'ON':'OFF')); $('nativeStatus').textContent=state.available ? 'CONNECTED':'NOT RUNNING';
 $('nativeCopy').textContent=state.available ? (state.voice || 'Windows voice host connected.') : (state.text || 'Run npm run desktop on Windows. This webpage never turns on a browser speech recognizer.');
 $('speechDetail').textContent=state.speech ? 'Last speech event — '+state.speech.status.toUpperCase()+': '+state.speech.detail : 'Press Talk locally, accept the native microphone dialog, then speak when LISTENING appears. Uses the Windows default recording device.';
 $('reviewHeard').hidden=state.speech?.status !== 'rejected' || !state.speech?.text;
 $('heardText').textContent=state.speech?.text ? 'Windows heard: '+state.speech.text+(state.speech.confidence === null ? '' : ' ('+Math.round(state.speech.confidence*100)+'% confidence)') : '';
 const live=state.mic && state.audioAgeMs !== null && state.audioAgeMs < 2000 && Number.isFinite(state.audioLevel);
 $('audioMeter').value=live ? state.audioLevel : 0; $('audioLabel').textContent=state.micUnknown ? 'Microphone level: UNKNOWN (native status unavailable)' : live ? 'Windows input level: '+state.audioLevel+' / 100' : (state.mic ? 'Waiting for Windows input-level samples…' : 'Microphone level: not capturing');
 $('retryButton').hidden=!state.retryAvailable;
 $('listenButton').disabled=!state.available || state.busy; $('muteButton').disabled=!state.available; $('stopButton').disabled=!state.available;
 $('runButton').disabled=Boolean(state.busy); $('allow').disabled=$('deny').disabled=approvalSubmitting || !state.available;
 const total=Number.isFinite(state.lastMs) ? `${state.lastMs} ms total` : 'completing';
 $('latency').textContent=Number.isFinite(state.firstTextMs) ? `${state.firstTextMs} ms first text · ${total}` : (state.lastMs == null ? 'Not measured' : `${state.lastMs} ms`);
 if (state.busy && !state.draft && !state.approval) { $('result').textContent='Preparing a reply…'; $('resultKind').textContent='REQUEST IN PROGRESS'; }
 if (state.busy && state.draft && !state.approval) { $('result').textContent=state.draft; $('resultKind').textContent='RESPONDING · LOCAL MODEL'; }
 if (!state.busy && state.text && (state.recent?.length || phase === 'reminder')) $('result').textContent=state.text;
 const previousApproval=approvalId, permissionFocused=$('permission').contains(document.activeElement) || (permissionFocusRequest && permissionFocusRequest === approvalId && document.activeElement === document.body);
 approvalId=state.approval?.id || ''; $('permission').hidden=!approvalId; $('approvalText').textContent=(state.approval?.description || '') + (state.approval?.preview ? '\n'+approvalPreviewText(state.approval.preview) : '');
 setText('permissionStatus', approvalId ? 'Permission required. Review the action, then choose Allow once or Deny. Escape denies only while focus is in these permission controls.' : 'No tool approval pending.');
 if (previousApproval && !approvalId && permissionFocused) $('command').focus();
 if (previousApproval && approvalId && previousApproval !== approvalId && permissionFocused) $('deny').focus();
 if (permissionFocusRequest && approvalId && !approvalSubmitting && permissionFocused) $('deny').focus();
 if (!approvalSubmitting) permissionFocusRequest='';
 if (state.recent?.length) {
  $('recent').replaceChildren();
  for (const record of state.recent) { const li=document.createElement('li'), command=document.createElement('span'), timing=document.createElement('span'); command.textContent=(record.ok ? '↗ ':'! ')+record.command; timing.textContent=`${record.ms} ms`; timing.className='timing'; li.append(command,timing); $('recent').append(li); }
 }
 $('footerState').textContent=state.micUnknown ? 'MIC UNKNOWN · VERIFY MICROPHONE IN THE NATIVE TRAY' : state.mic ? 'MIC ON · LOCAL WINDOWS RECOGNITION' : 'MIC OFF · NO BROWSER AUDIO CAPTURE';
}
async function refresh() {
 if(refreshing) return; refreshing=true;
 try {
  const state=await api('/api/desktop'); render(state);
  $('connection').textContent='LOCAL SERVICE CONNECTED'; $('notice').hidden=Boolean(state.available);
  $('notice').textContent=state.available ? '' : 'The service is connected, but the native voice host is not running. Time, system status and bounded file search work here; desktop voice and app actions require npm run desktop on Windows.';
  try { const health=await api('/api/health');
  $('modelName').textContent=health.model; $('provider').textContent=health.provider;
  if (lastModel !== health.model) { $('modelStatus').textContent='Installed-model availability not yet checked. Configure to inspect.'; lastModel=health.model; }
  } catch(err) { $('modelStatus').textContent='Model status unavailable: '+err.message; }
  const link=new URL('/index.html',location.origin); if(key) link.searchParams.set('key',key); $('historyLink').href=link.pathname+link.search;
 } catch (err) { setText('permissionStatus', 'Approval status unknown. Permission controls are disabled until the service reconnects.'); $('connection').textContent='CONNECTION NEEDED'; $('notice').hidden=false; $('notice').textContent=err.message; $('nativeStatus').textContent='UNKNOWN'; $('nativeCopy').textContent='Service connection lost. The previous connected status is stale. Check the native tray; this page cannot verify or mute its microphone.'; for(const id of ['retryButton','listenButton','muteButton','stopButton','runButton','allow','deny']) $(id).disabled=true; $('audioMeter').value=0; $('audioLabel').textContent='Microphone level: UNKNOWN (connection lost)'; setText('micState', 'UNKNOWN'); $('footerState').textContent='CONNECTION LOST · VERIFY MICROPHONE IN THE NATIVE TRAY'; publishMotion({phase:'attention',mic:false}); $('presenceTitle').textContent='Connection needs attention.'; $('presenceCopy').textContent='This page cannot verify microphone state. Use the native tray to mute or quit Quasnooze.'; } finally {refreshing=false;}
}
async function run(text) {
 if (!text.trim()) return;
 $('runButton').disabled=true; $('resultKind').textContent='REQUEST IN PROGRESS';
 try { const result=await api('/api/desktop',{text}); $('result').textContent=result.text; $('resultKind').textContent=(result.ok ? 'COMPLETED':'NEEDS ATTENTION')+(result.fastPath ? ' · NO LLM':' · LOCAL MODEL'); }
 catch(err) { $('result').textContent=err.message; $('resultKind').textContent='REFUSED'; }
 finally { await refresh(); }
}
$('reviewHeard').onclick=()=>{$('command').value=current.speech?.text || '';$('command').focus();toast('Review and correct the draft, then press Run. Nothing was executed.');};
$('commandForm').onsubmit=e=>{e.preventDefault(); const text=$('command').value; $('command').value=''; run(text);};
for(const button of document.querySelectorAll('[data-command]')) button.onclick=()=>run(button.dataset.command);
for(const button of document.querySelectorAll('[data-close]')) button.onclick=()=>$(button.dataset.close).close();
$('nativeHelp').onclick=()=>$('nativeDialog').showModal();
for(const [id,control] of [['retryButton','retry'],['listenButton','listen'],['muteButton','mute'],['stopButton','stop-voice']]) $(id).onclick=()=>api('/api/desktop',{control}).then(refresh).catch(e=>{toast(e.message);$('notice').hidden=false;$('notice').textContent=e.message;refresh();});
async function approve(allowed) {
 if (!approvalId || approvalSubmitting || $('deny').disabled) return;
 const id=approvalId; if ($('permission').contains(document.activeElement)) permissionFocusRequest=id; approvalSubmitting=true; $('allow').disabled=$('deny').disabled=true;
 try { await api('/api/desktop',{approval:{id,allowed}}); } catch(e) {toast(e.message);}
 finally { approvalSubmitting=false; await refresh(); }
}
$('permission').onkeydown=event=>{
 if(event.key === 'Escape' && approvalId && !$('deny').disabled && !['nativeDialog','modelDialog','keyDialog'].some(id=>$(id).open)) { event.preventDefault(); approve(false); }
};
$('allow').onclick=()=>approve(true); $('deny').onclick=()=>approve(false);
async function loadModels() {
 $('modelFeedback').textContent='Checking Ollama’s installed models…'; $('saveModel').disabled=true;
 try { const data=await api('/api/models'); const models=data.ollama?.models || []; $('modelSelect').replaceChildren();
  for(const model of models){const option=document.createElement('option'); option.value=model; option.textContent=model; option.selected=model===data.active?.model; $('modelSelect').append(option);}
  $('saveModel').disabled=!models.length; $('modelFeedback').textContent=models.length ? 'Choose an installed model. List probes may be cached for up to 30 seconds; selection is freshly checked.' : 'Ollama has no available models, or is unreachable. Start Ollama and pull a model first.';
  $('modelStatus').textContent=data.active?.provider==='ollama' ? (models.includes(data.active.model) ? 'Selected model is listed as installed. Inference speed not benchmarked.' : 'Selected model is not listed as installed. Choose a real model.') : 'Not a local Ollama selection. Desktop requests never silently use a cloud provider.';
 }catch(e){$('modelFeedback').textContent=e.message;}
}
function modelDialog(){ $('modelDialog').showModal(); loadModels(); }
$('modelButton').onclick=modelDialog; $('settingsNav').onclick=modelDialog; $('refreshModels').onclick=loadModels;
$('saveModel').onclick=async()=>{try{await api('/api/models',{provider:'ollama',model:$('modelSelect').value}); $('modelDialog').close(); toast('Local model selected for subsequent turns.'); await refresh();}catch(e){$('modelFeedback').textContent=e.message;}};
$('saveKey').onclick=()=>{key=$('keyInput').value.trim();sessionStorage.setItem('pinch.desktop.key',key);$('keyInput').value='';$('keyDialog').close();refresh();};
function clock(){ $('clock').textContent=new Date().toLocaleString('en-IN',{weekday:'short',hour:'2-digit',minute:'2-digit'}).toUpperCase(); }
clock();setInterval(clock,30000);refresh();setInterval(refresh,1500);
