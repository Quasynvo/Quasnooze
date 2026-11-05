/** Explicit user commands only; model output never dispatches these commands. */
import { loadPersonas, activePersona, savePersona, selectPersona, removePersona } from './store.js';
export function personaCommand(text, sessionId) {
  const match = /^\/persona(?:\s+(\S[\s\S]*))?$/i.exec(String(text).trim());
  if (!match) return null;
  const input=(match[1] || '').trim();
  const help='Commands: /persona list · /persona show <name> · /persona save <name> <style instructions> · /persona use <name|default> · /persona delete <name>';
  try {
    if (!input || input === 'list') {
      const state=loadPersonas();
      return `Active persona for this session: ${activePersona(sessionId)?.name || 'default'}\nSaved: ${state.personas.map(p=>p.name).join(', ') || '(none)'}${state.warning ? '\n'+state.warning : ''}\n${help}`;
    }
    const command=/^(show|save|use|delete)\s+(\S+)(?:\s+(\S[\s\S]*))?$/.exec(input);
    if (!command) return help;
    const [,action,name,instructions]=command;
    if (action !== 'save' && instructions) throw new Error('Unexpected extra arguments.');
    if (action === 'save') { savePersona(name,instructions); return `Saved persona ${name}. Use /persona use ${name} in the session you want to change. Safety and approval rules are unchanged.`; }
    if (action === 'use') { selectPersona(sessionId,name); return `This session now uses persona ${name}. Other sessions are unchanged; applies to subsequent turns.`; }
    if (action === 'delete') { removePersona(name); return `Deleted persona ${name}; sessions using it return to default.`; }
    const persona=loadPersonas().personas.find(p=>p.name===name);
    if (!persona) throw new Error('Persona not found.');
    return `${persona.name}\n${persona.instructions}`;
  } catch (error) { return `Persona unchanged: ${error.message}`; }
}
