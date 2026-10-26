import assert from 'node:assert/strict';
import { app, BrowserWindow } from 'electron';
import { mkdirSync, writeFileSync } from 'node:fs';

console.log('Electron fixture runner entered');
const html = process.argv[2];
const artifactDir = process.argv[3];
assert.ok(html, 'fixture HTML path is required');
assert.ok(artifactDir, 'artifact directory is required');
async function main() {
  let win;
  try {
  app.commandLine.appendSwitch('force-prefers-reduced-motion', 'reduce');
  await app.whenReady();
  console.log('Electron app ready');
  win = new BrowserWindow({
    show: false,
    width: 700,
    height: 600,
    webPreferences: { contextIsolation: true, backgroundThrottling: false },
  });
  await win.loadFile(html);
  console.log('Electron fixture loaded');
  mkdirSync(artifactDir, { recursive: true });
  const initial = await win.webContents.executeJavaScript(`(async()=>{
    const frame = () => new Promise(requestAnimationFrame);
    const root=Dropdown.buildDropdown('0',Array.from({length:40},(_,i)=>({value:String(i),label:'Option '+i})),{ariaLabel:'Fixture'});
    document.querySelector('#anchor').append(root); const scroller=document.querySelector('.scroller');
    window.primaryRoot=root;
    root.click(); await frame(); window.primaryMenu=document.getElementById(root.getAttribute('aria-controls')); const menu=window.primaryMenu;
    return {anchorTop:root.getBoundingClientRect().top, menuTop:menu.getBoundingClientRect().top,
      fixed:getComputedStyle(menu).position==='fixed', reducedMotion:matchMedia('(prefers-reduced-motion: reduce)').matches,
      animationOff:getComputedStyle(menu).animationName==='none'};
  })()`);
  writeFileSync(`${artifactDir}/before-scroll.png`, (await win.webContents.capturePage()).toPNG());
  const scroll = await win.webContents.executeJavaScript(`(async()=>{
    const frame = () => new Promise(requestAnimationFrame);
    const root=window.primaryRoot; const menu=window.primaryMenu;
    const scroller=document.querySelector('.scroller'); const initialTop=menu.getBoundingClientRect().top; const anchor0=root.getBoundingClientRect().top;
    scroller.scrollTop=10; await frame(); await frame();
    const movedTop=menu.getBoundingClientRect().top, anchor1=root.getBoundingClientRect().top;
    const follow=Math.abs((movedTop-initialTop)-(anchor1-anchor0))<2;
    return {follow, movedTop, anchor1};
  })()`);
  writeFileSync(`${artifactDir}/after-scroll.png`, (await win.webContents.capturePage()).toPNG());
  const details = await win.webContents.executeJavaScript(`(async()=>{
    const frame = () => new Promise(requestAnimationFrame);
    const root=window.primaryRoot; const menu=window.primaryMenu; const scroller=document.querySelector('.scroller');
    menu.scrollTop=0; root.dispatchEvent(new KeyboardEvent('keydown',{key:'End',bubbles:true}));
    const localScroll=menu.scrollTop>0 && scroller.scrollTop===10;
    const popupRect=menu.getBoundingClientRect();
    const withinViewport=popupRect.top>=7 && popupRect.bottom<=window.innerHeight-7;
    const card=document.querySelector('#compact-card');
    const cardRoot=Dropdown.buildDropdown('0',Array.from({length:40},(_,i)=>({value:String(i),label:'Option '+i})),{ariaLabel:'Compact card fixture'});
    card.append(cardRoot); cardRoot.click(); await frame();
    const cardMenu=document.getElementById(cardRoot.getAttribute('aria-controls'));
    const cardRect=card.getBoundingClientRect();
    const escapesCard=cardMenu.getBoundingClientRect().height>cardRect.height;
    return {localScroll,withinViewport,escapesCard,cardHeight:cardRect.height,cardMenuHeight:cardMenu.getBoundingClientRect().height};
  })()`);
  writeFileSync(`${artifactDir}/compact-graphics-card.png`, (await win.webContents.capturePage()).toPNG());
  const scrollClip = await win.webContents.executeJavaScript(`(async()=>{
    const frame = () => new Promise(requestAnimationFrame);
    const root=window.primaryRoot; const menu=window.primaryMenu; const scroller=document.querySelector('.scroller');
    root.click(); scroller.scrollTop=999; await frame(); await frame();
    const closed=menu.hidden && menu.parentElement===root;
    scroller.scrollTop=10; await frame(); root.click(); await frame();
    scroller.style.top='80px'; await frame();
    return {closed};
  })()`);
  win.setContentSize(700, 220);
  await new Promise((resolve) => setTimeout(resolve, 100));
  const resized = await win.webContents.executeJavaScript(`(async()=>{
    await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame);
    const root=window.primaryRoot; const menu=window.primaryMenu; const scroller=document.querySelector('.scroller');
    const rect=menu.getBoundingClientRect(), rootRect=root.getBoundingClientRect(), clip=scroller.getBoundingClientRect();
    return {flippedAbove:rect.bottom<=rootRect.top+1, withinViewport:rect.top>=7 && rect.bottom<=window.innerHeight-7, maxHeight:parseFloat(menu.style.maxHeight)};
  })()`);
  const keyboard = await win.webContents.executeJavaScript(`(()=>{
    const root=window.primaryRoot; const menu=window.primaryMenu;
    root.focus(); root.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
    const escaped=menu.hidden && menu.parentElement===root;
    root.dispatchEvent(new KeyboardEvent('keydown',{key:'Home',bubbles:true}));
    root.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true}));
    root.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));
    const chose=menu.hidden && root.value==='1';
    root.click(); window.fixtureRoot=root; window.detachedMenu=window.primaryMenu; root.remove();
    return {escaped,chose,detachedMenu};
  })()`);
  await new Promise((resolve) => setTimeout(resolve, 32));
  const detached = await win.webContents.executeJavaScript(`(()=>({closed:window.detachedMenu.hidden,restored:window.detachedMenu.parentElement===window.fixtureRoot}))()`);
  const result = { ...initial, ...scroll, ...details, ...scrollClip, ...resized, ...keyboard, detachedClosed: detached.closed, detachedRestored: detached.restored };
  console.log('Dropdown fixture diagnostics:', result);
  for (const name of ['fixed','reducedMotion','animationOff','follow','localScroll','withinViewport','escapesCard','closed','flippedAbove','escaped','chose','detachedClosed','detachedRestored']) assert.equal(result[name], true, name);
  assert.ok(result.maxHeight <= 320, 'resized menu height must remain capped');
  console.log('Dropdown Chromium anchoring fixture passed:', result, `screenshots: ${artifactDir}`);
  } finally {
    if (win && !win.isDestroyed()) win.destroy();
    app.quit();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
