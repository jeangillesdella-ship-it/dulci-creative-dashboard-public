import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const script=readFileSync(new URL('../public/dulci-creative-dashboard.js',import.meta.url),'utf8');
const loader=script.slice(script.indexOf('async function loadData('),script.indexOf('\nfunction exportCsv('));
const auto=script.slice(script.indexOf('function autoRefresh()'),script.indexOf('\nsetInterval(autoRefresh'));
function harness(responses,staticHost=false){
 const elements=new Map();
 const $=key=>{if(!elements.has(key))elements.set(key,{value:key==='#platform'?'android':key==='#startDate'?'2026-09-15':'2026-09-16',textContent:'',disabled:false});return elements.get(key)};
 const calls=[];
 const context=vm.createContext({$,Date,URLSearchParams,AbortSignal,IS_STATIC_PUBLIC_HOST:staticHost,LIVE_DATA_URL:'/api/adjust/dulci-creatives',AUTO_REFRESH_MS:300000,document:{hidden:false},state:{rows:[],creativeAssets:new Map([['video',{}]])},fetch:async url=>{calls.push(String(url));const r=responses.shift();if(r instanceof Error)throw r;return {ok:true,json:async()=>r}},aggregateCreativeRows:r=>r,aggregateTrendRows:r=>r,rowsFromSnapshot:r=>r.rows,refreshOptions(){},applyFilters(){},renderPivot(){},loadCreativeAssets:async()=>{}});
 vm.runInContext('let dataLoading=false;let lastDataCheck=0;let activeQuery=null;'+loader+'\n'+auto,context);
 return {context,$,calls,run:()=>vm.runInContext('loadData()',context)};
}
test('fresh live data retains query time and is not called a snapshot',async()=>{
 const h=harness([{rows:[{cost:12}],trend:[{day:'2026-09-16'}],fetchedAt:new Date().toISOString(),cached:true}]);await h.run();
 assert.match(h.$('#freshness').textContent,/5分钟内缓存/);assert.doesNotMatch(h.$('#freshness').textContent,/快照/);
 assert.match(h.$('#message').textContent,/2026-09-16/);assert.equal(h.$('#queryBtn').disabled,false);
});
test('upstream failure visibly warns when falling back to stale snapshot',async()=>{
 const h=harness([new Error('upstream unavailable'),{rows:[{day:'2026-09-14'}],fetchedAt:'2026-09-14T00:00:00Z'}]);await h.run();
 assert.equal(h.$('#message').className,'message error');assert.match(h.$('#message').textContent,/不是实时数据/);assert.match(h.$('#freshness').textContent,/数据已过期/);
 assert.ok(h.calls[1].startsWith('https://jeangillesdella-ship-it.github.io/'));
});
test('public static host never calls unavailable live API',async()=>{
 const h=harness([{rows:[],fetchedAt:new Date().toISOString(),dataThrough:'2026-09-16'}],true);await h.run();
 assert.equal(h.calls.length,1);assert.match(h.calls[0],/^\.\/data\/latest.json\?t=/);
});
test('automatic refresh skips hidden tab and unsaved date edits',()=>{
 const h=harness([]);vm.runInContext('document.hidden=true;autoRefresh()',h.context);assert.equal(h.calls.length,0);
 vm.runInContext('document.hidden=false;activeQuery={start:"2026-09-01",end:"2026-09-06",platform:"android"};autoRefresh()',h.context);assert.equal(h.calls.length,0);
});
