/** Model-protocol cleanup, NOT an HTML sanitizer. User/tool text is never passed here. */
const OPEN = ['<think>', '&lt;think&gt;'];
const CLOSE = ['</think>', '&lt;/think&gt;'];
const narration = /^(?:(?:okay|ok|alright)[,!.\s]+(?:the user|let me|i (?:need|should))|the user (?:said|asked)|let me (?:think|reason|analy[sz]e)|i (?:need|should) (?:to )?(?:respond|think|figure))/i;
function closing(text) {
  const lower = text.toLowerCase();
  return CLOSE.map(tag => ({at:lower.indexOf(tag),tag})).filter(x=>x.at>=0).sort((a,b)=>a.at-b.at)[0];
}
export function assistantText(value, { complete = true } = {}) {
  let text=String(value || '').trimStart(), filtered=false;
  for (;;) {
    const lower=text.toLowerCase(), open=OPEN.find(tag=>lower.startsWith(tag));
    if (!open) {
      const emptyClose=CLOSE.find(tag=>lower.startsWith(tag));
      if (emptyClose) { text=text.slice(emptyClose.length).trimStart();filtered=true;continue; }
      break;
    }
    let depth=1, offset=open.length, end=null;
    while (depth) {
      const rest=text.slice(offset), nextClose=closing(rest);
      if (!nextClose) return {text:'',filtered:true};
      const nextOpen=OPEN.map(tag=>({at:rest.toLowerCase().indexOf(tag),tag})).filter(x=>x.at>=0).sort((a,b)=>a.at-b.at)[0];
      if (nextOpen && nextOpen.at<nextClose.at) { depth++;offset+=nextOpen.at+nextOpen.tag.length; }
      else { depth--;offset+=nextClose.at+nextClose.tag.length;end=offset; }
    }
    filtered=true;text=text.slice(end).trimStart();
  }
  // Some old templates prefill the opening tag, exposing only its closing tag.
  // Quarantine recognizable leading self-narration before any streaming output.
  if (narration.test(text)) {
    const end=closing(text);
    if (!end) return {text:'',filtered:true};
    text=text.slice(end.at+end.tag.length).trimStart(); filtered=true;
  }
  if (!complete) {
    const lower=text.toLowerCase();
    if ([...OPEN,...CLOSE].some(tag=>tag.startsWith(lower)) || !/[.!?\n]/.test(text) && text.length<160) return {text:'',filtered};
  }
  return {text,filtered};
}
export class AssistantTextStream {
  constructor(emit) { this.raw='';this.sent='';this.emit=emit; }
  push(piece) {
    this.raw+=piece;
    this.publish(assistantText(this.raw,{complete:false}).text);
  }
  publish(text) {
    if (!text.startsWith(this.sent)) return; // Never emit a contradictory replacement.
    const piece=text.slice(this.sent.length);this.sent=text;
    if(piece)this.emit(piece);
  }
  finish(raw=this.raw) {
    const result=assistantText(raw);this.publish(result.text);return result;
  }
}
