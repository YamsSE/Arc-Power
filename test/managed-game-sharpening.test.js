import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createManagedGameSharpening } from '../src/main/managed-game-sharpening.js';
import { createScreenPostprocessSharpening } from '../src/main/sharpening-screen.js';
import { encodeManagedLaunchRequest, quoteWindowsArgument } from '../src/main/managed-game-launcher.js';

const game={pid:123,creationFiletime:'134371481673264853',exePath:'C:\\Games\\Example\\Game.exe'};
const tick=()=>new Promise(r=>setImmediate(r));
test('managed sharpening applies and disables the shader without any ASR dependency',async()=>{
 let enabled=true,percent=73,revision=0;const writes=[];
 const service=createManagedGameSharpening({control:{query:async()=>({status:0,acceptedRevision:revision,appliedRevision:revision}),set:async value=>{writes.push(value);revision=value.revision;return{status:0,acceptedRevision:revision,appliedRevision:revision};},stop:async()=>{}},
 launcher:{ready:()=>true,launch:async()=>game},detector:{detectProcessIdentity:async()=>game},isGameExecutable:async()=>true,effectiveFor:()=>({enabled,percentage:percent}),isEnabled:()=>enabled,pollMs:60000});
 try{
  service.start();await service.settingsChanged();
  assert.equal(service.state().active,true);assert.equal(writes.at(-1).percentage,73);
  percent=25;await service.settingsChanged();assert.equal(writes.at(-1).percentage,25);
  percent=0;await service.settingsChanged();assert.equal(writes.at(-1).enabled,false);assert.equal(service.state().active,false);
  percent=25;await service.settingsChanged();assert.equal(service.state().active,true);
  enabled=false;await service.settingsChanged();assert.equal(writes.at(-1).enabled,false);assert.equal(service.state().active,false);
 }finally{await service.stop();}
});

test('a game without the runtime is checked once, and an explicit launch permits startup retry',async()=>{
 let queries=0,available=false,revision=0;
 const service=createManagedGameSharpening({control:{query:async()=>{queries++;if(!available)throw new Error('missing pipe');return{status:0,acceptedRevision:revision,appliedRevision:revision};},set:async v=>{revision=v.revision;return{status:0,acceptedRevision:revision,appliedRevision:revision};},stop:async()=>{}},
 launcher:{ready:()=>true,launch:async()=>game},detector:{detectProcessIdentity:async()=>game},isGameExecutable:async()=>true,effectiveFor:()=>({enabled:true,percentage:50}),isEnabled:()=>true,pollMs:60000});
 try{service.start();await service.settingsChanged();await service.settingsChanged();assert.equal(queries,1);assert.match(service.state().reason,/Launch the game/);available=true;await service.launchGame(game.exePath);await service.settingsChanged();assert.equal(service.state().active,true);}finally{await service.stop();}
});

test('sharpening and ASR retain independent active states and switches',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'arc-independent-sharpen-'));let child,spawns=0,policy;let active=false;const events=[];
 class Stream extends EventEmitter{destroyed=false;write(){}end(){this.destroyed=true;}setEncoding(){}}
 class Child extends EventEmitter{stdin=new Stream();stdout=new Stream();stderr=new Stream();kill(){this.emit('exit',0);}}
 const service=createScreenPostprocessSharpening({dir,detector:{detectProcessIdentity:async()=>game},isGameExecutable:async()=>true,allowCaptureOverlay:false,allowAsrCapture:true,
  createManagedRuntime:p=>{policy=p;return{state:()=>({runtimeReady:true,active,provider:'managed',launchSupported:true,reason:null}),start(){},stop:async()=>{},settingsChanged:async()=>{active=p.isEnabled();p.onChange();}};},
  spawn:()=>{spawns++;child=new Child();setImmediate(()=>child.stdout.emit('data','READY screen-sharpen-v1\n'));return child;},pollMs:60000});
 service.subscribeStatus(v=>events.push(v));
 try{
  await service.start();await service.setGlobal({enabled:true,percentage:81});assert.equal(spawns,0,'standalone in-game sharpening starts no capture helper');
  await service.setAsr({enabled:true});child.stdout.emit('data',`ACTIVE ${game.pid} ASR\n`);await tick();
  assert.equal((await service.getGlobal()).active,true);assert.equal((await service.getAsr()).active,true);
  assert.equal(events.at(-1).sharpeningActive,true);assert.equal(events.at(-1).asrActive,true);
  await service.setAsr({enabled:false});assert.equal((await service.getGlobal()).active,true);assert.equal((await service.getGlobal()).value.percentage,81);
  await service.setAsr({enabled:true});child.stdout.emit('data',`ACTIVE ${game.pid} ASR\n`);
  await service.setGlobal({enabled:false,percentage:81});assert.equal((await service.getAsr()).active,true);assert.equal((await service.getGlobal()).active,false);
  assert.deepEqual(policy.effectiveFor(game.exePath),{enabled:false,percentage:0});
 }finally{await service.stop();fs.rmSync(dir,{recursive:true,force:true});}
});

test('launch packet preserves Unicode paths and Windows argument quoting',()=>{
 assert.equal(quoteWindowsArgument('a b\\'),'"a b\\\\"');assert.equal(quoteWindowsArgument('say "yes"'),'"say \\"yes\\""');
 const packet=encodeManagedLaunchRequest({exePath:'C:\\Games\\測試\\Game.exe',cwd:'C:\\Games\\測試',args:['a b'],runtimePath:'C:\\Runtime\\ReShade64.dll',runtimeHash:'A'.repeat(64)});
 assert.equal(packet.readUInt32LE(),0x314c5341);assert.equal(packet.readUInt32LE(4),6);
 assert.throws(()=>encodeManagedLaunchRequest({exePath:'relative.exe',cwd:'C:\\Games',runtimePath:'C:\\Runtime.dll',runtimeHash:'A'.repeat(64)}),/Invalid/);
});
