'use strict';
const byId = id => document.getElementById(id);
const queryKey = new URLSearchParams(location.search).get('key');
let key = queryKey || sessionStorage.getItem('pinch.desktop.key') || localStorage.getItem('pinch.key') || '';
if (queryKey) { sessionStorage.setItem('pinch.desktop.key', queryKey); history.replaceState(null, '', location.pathname); }
let current = {}, approvalId = '', approvalSubmitting = false, permissionFocusRequest = '', lastModel = '', refreshing = false;
const headers = () => ({'content-type':'application/json', ...(key ? {'x-quasnooze-key':key} : {})});
async function api(path, body) {
 let response;
 try { response = await fetch(path, {method:body === undefined ? 'GET':'POST', headers:headers(), ...(body === undefined ? {signal:AbortSignal.timeout(5000)} : {}), ...(body === undefined ? {} : {body:JSON.stringify(body)})}); }
 catch (err) { throw Error((err.name === 'TimeoutError' ? 'Quasnooze did not respond in time.' : 'Cannot reach the Quasnooze service at '+location.origin+'.')+' Keep npm run desktop running and reopen Deck from the native Windows widget.'); }
 if (response.status === 401) { if (!byId('keyDialog').open) byId('keyDialog').showModal(); throw Error('Enter this instance’s key to connect.'); }
 const data = await response.json(); if (!response.ok) throw Error(data.error || 'The request was refused.'); return data;
}
function setText(id, text) { if (byId(id).textContent !== text) byId(id).textContent = text; }
function toast(text) { byId('toast').textContent=text; byId('toast').hidden=false; clearTimeout(toast.timer); toast.timer=setTimeout(()=>byId('toast').hidden=true,5000); }
const labels = {starting:['Starting the Windows host.','Waiting for its ready event; microphone is off.'],recovering:['Companion recovery in progress.','Reconnects start muted. Interrupted side-effect outcomes are unknown; nothing is replayed.'],unavailable:['Companion unavailable.','Automatic retries stopped. Inspect interrupted actions, then explicitly Retry companion.'],'not-running':['Desktop is not connected.','Run the Windows host for local wake listening, spoken replies and desktop actions.'], muting:['Stopping the local microphone.','Waiting for Windows to confirm release; input status is not yet off.'], muted:['Here. With the microphone off.','Enable local wake in the native widget when you want hands-free help.'], armed:['Call me when you need me.','Say “Hey Quasnooze”, pause for LISTENING, then give one request.'], listening:['I’m listening.','One request at a time. Local Windows speech recognition is active.'], working:['Working on your request.','Microphone paused while the request runs. Common actions skip model inference.'], approval:['Your call. Not mine.','Review the exact action below or in the Windows widget. Voice cannot approve it.'], speaking:['Here’s what happened.','Local Windows speech is reading the result. Stop voice does not cancel a running task.'], ready:['Done. Still here.','See the result below. You remain in control of the next action.'], attention:['Something needs attention.','Read the actual error below. No fake offline conversation or automatic cloud fallback.'], reminder:['A little nudge.','Your reminder is here.']};
function kindText(ok, acted, fastPath) {
 const head = !ok ? 'NEEDS ATTENTION' : (acted === false ? 'REPLIED · NO TOOLS RAN' : 'COMPLETED');
 return head + (fastPath ? ' · NO LLM' : ' · LOCAL MODEL');
}
function publishMotion(state) { if (typeof CustomEvent === 'function' && typeof globalThis.dispatchEvent === 'function') globalThis.dispatchEvent(new CustomEvent('quasnooze:motion', {detail:state})); }
function render(state) {
 publishMotion(state);
 byId('retryButton').disabled=false;
 current=state; const phase=state.phase || 'not-running', label=labels[phase] || labels.ready;
 byId('presence').dataset.phase=phase; byId('phase').textContent=phase.replaceAll('-',' ').toUpperCase();
 byId('presenceTitle').textContent=(phase === 'ready' && state.acted === false) ? 'Replied. No tools ran.' : label[0];
 byId('presenceCopy').textContent=label[1];
 setText('micState', state.micUnknown ? 'UNKNOWN' : (state.mic ? 'ON':'OFF')); byId('nativeStatus').textContent=state.available ? 'CONNECTED':'NOT RUNNING';
 byId('nativeCopy').textContent=state.available ? (state.voice || 'Windows voice host connected.') : (state.text || 'Run npm run desktop on Windows. This webpage never turns on a browser speech recognizer.');
 byId('speechDetail').textContent=state.speech ? 'Last speech event — '+state.speech.status.toUpperCase()+': '+state.speech.detail : 'Press Talk locally, accept the native microphone dialog, then speak when LISTENING appears. Uses the Windows default recording device.';
 byId('reviewHeard').hidden=state.speech?.status !== 'rejected' || !state.speech?.text;
 byId('heardText').textContent=state.speech?.text ? 'Windows heard: '+state.speech.text+(state.speech.confidence === null ? '' : ' ('+Math.round(state.speech.confidence*100)+'% confidence)') : '';
 const live=state.mic && state.audioAgeMs !== null && state.audioAgeMs < 2000 && Number.isFinite(state.audioLevel);
 byId('audioMeter').value=live ? state.audioLevel : 0; byId('audioLabel').textContent=state.micUnknown ? 'Microphone level: UNKNOWN (native status unavailable)' : live ? 'Windows input level: '+state.audioLevel+' / 100' : (state.mic ? 'Waiting for Windows input-level samples…' : 'Microphone level: not capturing');
 byId('retryButton').hidden=!state.retryAvailable;
 byId('listenButton').disabled=!state.available || state.busy; byId('muteButton').disabled=!state.available; byId('stopButton').disabled=!state.available;
 byId('runButton').disabled=Boolean(state.busy); byId('allow').disabled=byId('deny').disabled=approvalSubmitting || !state.available;
 const total=Number.isFinite(state.lastMs) ? `${state.lastMs} ms total` : 'completing';
 byId('latency').textContent=Number.isFinite(state.firstTextMs) ? `${state.firstTextMs} ms first text · ${total}` : (state.lastMs == null ? 'Not measured' : `${state.lastMs} ms`);
 if (state.busy && !state.draft && !state.approval) { byId('result').textContent='Preparing a reply…'; byId('resultKind').textContent='REQUEST IN PROGRESS'; }
 if (state.busy && state.draft && !state.approval) { byId('result').textContent=state.draft; byId('resultKind').textContent='RESPONDING · LOCAL MODEL'; }
 if (!state.busy && state.text && (state.recent?.length || phase === 'reminder')) {
  byId('result').textContent=state.text;
  if (state.recent?.length && phase !== 'reminder') byId('resultKind').textContent=kindText(state.recent[0].ok, state.acted, state.fastPath);
 }
 const previousApproval=approvalId, permissionFocused=byId('permission').contains(document.activeElement) || (permissionFocusRequest && permissionFocusRequest === approvalId && document.activeElement === document.body);
 approvalId=state.approval?.id || ''; byId('permission').hidden=!approvalId; byId('approvalText').textContent=(state.approval?.description || '') + (state.approval?.preview ? '\n'+approvalPreviewText(state.approval.preview) : '');
 setText('permissionStatus', approvalId ? 'Permission required. Review the action, then choose Allow once or Deny. Escape denies only while focus is in these permission controls.' : 'No tool approval pending.');
 if (previousApproval && !approvalId && permissionFocused) byId('command').focus();
 if (previousApproval && approvalId && previousApproval !== approvalId && permissionFocused) byId('deny').focus();
 if (permissionFocusRequest && approvalId && !approvalSubmitting && permissionFocused) byId('deny').focus();
 if (!approvalSubmitting) permissionFocusRequest='';
 if (state.recent?.length) {
  byId('recent').replaceChildren();
  for (const record of state.recent) { const li=document.createElement('li'), command=document.createElement('span'), timing=document.createElement('span'); command.textContent=(record.ok ? '↗ ':'! ')+record.command; timing.textContent=`${record.ms} ms`; timing.className='timing'; li.append(command,timing); byId('recent').append(li); }
 }
 byId('footerState').textContent=state.micUnknown ? 'MIC UNKNOWN · VERIFY MICROPHONE IN THE NATIVE TRAY' : state.mic ? 'MIC ON · LOCAL WINDOWS RECOGNITION' : 'MIC OFF · NO BROWSER AUDIO CAPTURE';
}
async function refresh() {
 if(refreshing) return; refreshing=true;
 try {
  const state=await api('/api/desktop'); render(state);
  byId('connection').textContent='LOCAL SERVICE CONNECTED'; byId('notice').hidden=Boolean(state.available);
  byId('notice').textContent=state.available ? '' : 'The service is connected, but the native voice host is not running. Time, system status and bounded file search work here; desktop voice and app actions require npm run desktop on Windows.';
  try { const health=await api('/api/health');
  byId('modelName').textContent=health.model; byId('provider').textContent=health.provider;
  if (lastModel !== health.model) { byId('modelStatus').textContent='Installed-model availability not yet checked. Configure to inspect.'; lastModel=health.model; }
  } catch(err) { byId('modelStatus').textContent='Model status unavailable: '+err.message; }
  const link=new URL('/index.html',location.origin); if(key) link.searchParams.set('key',key); byId('historyLink').href=link.pathname+link.search;
 } catch (err) { setText('permissionStatus', 'Approval status unknown. Permission controls are disabled until the service reconnects.'); byId('connection').textContent='CONNECTION NEEDED'; byId('notice').hidden=false; byId('notice').textContent=err.message; byId('nativeStatus').textContent='UNKNOWN'; byId('nativeCopy').textContent='Service connection lost. The previous connected status is stale. Check the native tray; this page cannot verify or mute its microphone.'; for(const id of ['retryButton','listenButton','muteButton','stopButton','runButton','allow','deny']) byId(id).disabled=true; byId('audioMeter').value=0; byId('audioLabel').textContent='Microphone level: UNKNOWN (connection lost)'; setText('micState', 'UNKNOWN'); byId('footerState').textContent='CONNECTION LOST · VERIFY MICROPHONE IN THE NATIVE TRAY'; publishMotion({phase:'attention',mic:false}); byId('presenceTitle').textContent='Connection needs attention.'; byId('presenceCopy').textContent='This page cannot verify microphone state. Use the native tray to mute or quit Quasnooze.'; } finally {refreshing=false;}
}
async function run(text) {
 if (!text.trim()) return;
 byId('runButton').disabled=true; byId('resultKind').textContent='REQUEST IN PROGRESS';
 try { const result=await api('/api/desktop',{text}); byId('result').textContent=result.text; byId('resultKind').textContent=kindText(result.ok, result.acted, result.fastPath); }
 catch(err) { byId('result').textContent=err.message; byId('resultKind').textContent='REFUSED'; }
 finally { await refresh(); }
}
byId('reviewHeard').onclick=()=>{byId('command').value=current.speech?.text || '';byId('command').focus();toast('Review and correct the draft, then press Run. Nothing was executed.');};
byId('commandForm').onsubmit=e=>{e.preventDefault(); const text=byId('command').value; byId('command').value=''; run(text);};
for(const button of document.querySelectorAll('[data-command]')) button.onclick=()=>run(button.dataset.command);
for(const button of document.querySelectorAll('[data-close]')) button.onclick=()=>byId(button.dataset.close).close();
byId('nativeHelp').onclick=()=>byId('nativeDialog').showModal();
for(const [id,control] of [['retryButton','retry'],['listenButton','listen'],['muteButton','mute'],['stopButton','stop-voice']]) byId(id).onclick=()=>api('/api/desktop',{control}).then(refresh).catch(e=>{toast(e.message);byId('notice').hidden=false;byId('notice').textContent=e.message;refresh();});
async function approve(allowed) {
 if (!approvalId || approvalSubmitting || byId('deny').disabled) return;
 const id=approvalId; if (byId('permission').contains(document.activeElement)) permissionFocusRequest=id; approvalSubmitting=true; byId('allow').disabled=byId('deny').disabled=true;
 try { await api('/api/desktop',{approval:{id,allowed}}); } catch(e) {toast(e.message);}
 finally { approvalSubmitting=false; await refresh(); }
}
byId('permission').onkeydown=event=>{
 if(event.key === 'Escape' && approvalId && !byId('deny').disabled && !['nativeDialog','modelDialog','keyDialog'].some(id=>byId(id).open)) { event.preventDefault(); approve(false); }
};
byId('allow').onclick=()=>approve(true); byId('deny').onclick=()=>approve(false);
async function loadModels() {
 byId('modelFeedback').textContent='Checking Ollama’s installed models…'; byId('saveModel').disabled=true;
 try { const data=await api('/api/models'); const models=data.ollama?.models || []; byId('modelSelect').replaceChildren();
  for(const model of models){const option=document.createElement('option'); option.value=model; option.textContent=model; option.selected=model===data.active?.model; byId('modelSelect').append(option);}
  byId('saveModel').disabled=!models.length; byId('modelFeedback').textContent=models.length ? 'Choose an installed model. List probes may be cached for up to 30 seconds; selection is freshly checked.' : 'Ollama has no available models, or is unreachable. Start Ollama and pull a model first.';
  byId('modelStatus').textContent=data.active?.provider==='ollama' ? (models.includes(data.active.model) ? 'Selected model is listed as installed. Inference speed not benchmarked.' : 'Selected model is not listed as installed. Choose a real model.') : 'Not a local Ollama selection. Desktop requests never silently use a cloud provider.';
 }catch(e){byId('modelFeedback').textContent=e.message;}
}
function modelDialog(){ byId('modelDialog').showModal(); loadModels(); }
byId('modelButton').onclick=modelDialog; byId('settingsNav').onclick=modelDialog; byId('refreshModels').onclick=loadModels;
byId('saveModel').onclick=async()=>{try{await api('/api/models',{provider:'ollama',model:byId('modelSelect').value}); byId('modelDialog').close(); toast('Local model selected for subsequent turns.'); await refresh();}catch(e){byId('modelFeedback').textContent=e.message;}};
byId('saveKey').onclick=()=>{key=byId('keyInput').value.trim();sessionStorage.setItem('pinch.desktop.key',key);byId('keyInput').value='';byId('keyDialog').close();refresh();};
function clock(){ byId('clock').textContent=new Date().toLocaleString('en-IN',{weekday:'short',hour:'2-digit',minute:'2-digit'}).toUpperCase(); }
clock();setInterval(clock,30000);refresh();setInterval(refresh,1500);
