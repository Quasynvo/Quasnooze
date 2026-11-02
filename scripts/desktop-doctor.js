#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
if (process.platform !== 'win32') {
  console.error('Pinch desktop:doctor requires Windows. No microphone was opened.');
  process.exitCode = 1;
} else {
  const args = process.argv.slice(2);
  if (args.some(arg => !['--mic','--self-test'].includes(arg)) || args.length > 1) throw new Error('Usage: npm run desktop:doctor -- [--mic | --self-test]');
  const env = {};
  for (const k of ['SystemRoot','WINDIR','TEMP','TMP','USERPROFILE','APPDATA','LOCALAPPDATA']) if(process.env[k]) env[k]=process.env[k];
  const result = spawnSync(join(process.env.SystemRoot || 'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe'),
    ['-NoProfile','-NonInteractive','-STA','-ExecutionPolicy','Bypass','-File',fileURLToPath(new URL('../desktop/windows.ps1',import.meta.url)),'-Doctor',...(args.includes('--mic')?['-MicTest']:[]),...(args.includes('--self-test')?['-AudioSelfTest']:[])],
    {env,shell:false,windowsHide:true,stdio:'inherit',timeout:60000});
  if(result.error) console.error('Windows speech diagnostic could not complete:',result.error.message);
  process.exitCode=result.status ?? 1;
}
