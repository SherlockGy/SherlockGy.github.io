import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const source = readFileSync(new URL('../assets/app.js', import.meta.url), 'utf8');
const code = source.slice(source.indexOf('function syncReaderChrome()'), source.indexOf('function saveDocumentProgress()'));
function fixture() {
  const nodes = new Map();
  for (const id of ['#reader-show-tools', '#reader-hide-tools', '#reader-stage']) nodes.set(id, { hidden: false, scrollTop: 1234, attrs: {}, setAttribute(k,v) { this.attrs[k]=v; }, focus() { this.focused=true; } });
  const classes = new Set();
  const context = { readerChromeHidden: false, readerChromePosition: null, reading: true, reader: { classList: { toggle(k,on) { on ? classes.add(k) : classes.delete(k); } } }, $: s => nodes.get(s), isDocumentReading: () => context.reading, setReaderNoteOpen: () => { context.noteClosed=true; }, layoutReader: () => { context.layouts++; }, saveDocumentProgress: () => { context.saves++; }, layouts: 0, saves: 0 };
  vm.createContext(context); vm.runInContext(code, context);
  return {context,nodes,classes};
}
test('focus toggle hides chrome, closes notes, preserves scroll and leaves restore focus reachable', () => {
  const {context:c,nodes,classes}=fixture(); c.setReaderChromeHidden(true);
  assert.ok(classes.has('reader-focus')); assert.equal(nodes.get('#reader-show-tools').hidden,false);
  assert.ok(nodes.get('#reader-show-tools').focused); assert.ok(c.noteClosed);
  assert.equal(nodes.get('#reader-stage').scrollTop,1234); assert.equal(c.layouts,1);
  c.setReaderChromeHidden(true); assert.equal(c.layouts,1,'repeat request is idempotent');
  c.setReaderChromeHidden(false); assert.ok(!classes.has('reader-focus')); assert.equal(nodes.get('#reader-show-tools').hidden,true); assert.ok(nodes.get('#reader-hide-tools').focused);
});
test('ordinary gallery and whole-page layouts never retain hidden chrome', () => {
  const {context:c,classes}=fixture(); c.setReaderChromeHidden(true); c.reading=false; c.syncReaderChrome();
  assert.equal(c.readerChromeHidden,false); assert.ok(!classes.has('reader-focus'));
  c.setReaderChromeHidden(true); assert.equal(c.readerChromeHidden,false);
});
test('Escape restores chrome before fullscreen exit; new albums and close reset focus mode', () => {
  const cancel=source.slice(source.indexOf("reader.addEventListener('cancel'"),source.indexOf("$('#reader-hide-tools').addEventListener"));
  assert.ok(cancel.indexOf('readerChromeHidden') < cancel.indexOf('state.expanded'));
  assert.ok(source.includes('if (changed) {\n    readerChromeHidden = false; readerChromePosition = null;'));
  assert.ok(source.includes('readerChromeHidden = false; readerChromePosition = null; syncReaderChrome();'));
});
test('focus CSS hides both bars in expanded and regular document reading and provides a restore control', () => {
  const css=readFileSync(new URL('../assets/style.css', import.meta.url),'utf8');
  const html=readFileSync(new URL('../index.html', import.meta.url),'utf8');
  for(const name of ['reader-header','reader-toolbar','reader-footer']) assert.ok(css.includes(`.reader.document-album.reader-focus > .${name}`));
  assert.ok(css.includes('grid-template-rows: minmax(0, 1fr)')); assert.ok(html.includes('id="reader-show-tools"'));
});

test('bottom-of-document clamping restores the original position unless reader scrolls away', () => {
  const {context:c,nodes}=fixture(); const stage=nodes.get('#reader-stage'); let top=900;
  Object.defineProperty(stage,'scrollTop',{get:()=>top,set:value=>{top=Math.min(value,c.readerChromeHidden ? 700 : 900);}});
  c.setReaderChromeHidden(true); assert.equal(top,700);
  c.setReaderChromeHidden(false); assert.equal(top,900);
  c.setReaderChromeHidden(true); stage.scrollTop=500;
  c.setReaderChromeHidden(false); assert.equal(top,500,'intentional reading movement is preserved');
});
