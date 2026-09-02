#!/usr/bin/env node
// 区分 `import type` / `export type`（编译期擦除，运行时不成环）与值边，重算 SCC
import fs from 'node:fs'
import path from 'node:path'

const ROOT = '/Users/yitiansong/data/code/start-electron'
const SCOPES = [['core','packages/core'],['runtime','packages/onething-runtime/src'],['backend','packages/backend'],['shared','packages/shared'],['electron','apps/electron/src'],['server','apps/server/src']]
const EXT = new Set(['.ts','.tsx','.mts','.cts','.js','.mjs'])
const files=[],fileSet=new Set()
const isExcluded=p=>p.includes('/__tests__/')||p.includes('/__mocks__/')||p.includes('/__fixtures__/')||/\.(test|spec)\.[cm]?tsx?$/.test(p)||p.includes('/node_modules/')||p.includes('/dist/')||p.includes('/out/')
function walk(d){let e;try{e=fs.readdirSync(d,{withFileTypes:true})}catch{return}
for(const x of e){const f=path.join(d,x.name)
if(x.isDirectory()){if(['node_modules','__tests__','__mocks__','__fixtures__'].includes(x.name))continue;walk(f)}
else if(EXT.has(path.extname(x.name))&&!isExcluded(f)){files.push(f);fileSet.add(f)}}}
for(const[,r]of SCOPES)walk(path.join(ROOT,r))
const scopeOf=a=>{for(const[n,r]of SCOPES)if(a.startsWith(path.join(ROOT,r)+path.sep))return n;return null}
const rel=p=>path.relative(ROOT,p)
const loadPkg=d=>{try{return JSON.parse(fs.readFileSync(path.join(ROOT,d,'package.json'),'utf8'))}catch{return null}}
const PKGS={'@onething/core':{dir:'packages/core',pkg:loadPkg('packages/core')},'@onething/runtime':{dir:'packages/onething-runtime',pkg:loadPkg('packages/onething-runtime')},'@onething/backend':{dir:'packages/backend',pkg:loadPkg('packages/backend')},'@onething/gateway':{dir:'packages/gateway',pkg:loadPkg('packages/gateway')}}
const flat=v=>{if(typeof v==='string')return v;if(v&&typeof v==='object')for(const k of['import','default','node','require','types'])if(v[k]){const r=flat(v[k]);if(r)return r}return null}
function resolveExports(n,sub){const e=PKGS[n];if(!e?.pkg?.exports)return null;const exp=e.pkg.exports;const key=sub===''?'.':'./'+sub
if(typeof exp==='string')return path.join(ROOT,e.dir,exp)
if(exp[key]!==undefined){const t=flat(exp[key]);if(t)return path.join(ROOT,e.dir,t)}
let best=null;for(const k of Object.keys(exp)){if(!k.includes('*'))continue;const[pre,post]=k.split('*');if(key.startsWith(pre)&&key.endsWith(post)&&key.length>=pre.length+post.length){if(!best||pre.length>best.pre.length)best={k,pre,post}}}
if(best){const star=key.slice(best.pre.length,key.length-best.post.length);const t=flat(exp[best.k]);if(t)return path.join(ROOT,e.dir,t.replace('*',star))}
return null}
function tryFile(p){const c=[];if(/\.[cm]?js$/.test(p))c.push(p.replace(/\.([cm]?)js$/,'.$1ts'),p.replace(/\.([cm]?)js$/,'.$1tsx'));c.push(p)
for(const e of['.ts','.tsx','.mts','.cts','.js','.mjs'])c.push(p+e)
for(const e of['/index.ts','/index.tsx','/index.js','/index.mts'])c.push(p+e)
for(const x of c){if(fileSet.has(x))return x;try{if(fs.statSync(x).isFile())return x}catch{}}return null}
function resolveSpec(s,f){
if(s.startsWith('.'))return tryFile(path.resolve(path.dirname(f),s))
if(s==='@shared')return tryFile(path.join(ROOT,'packages/shared/index'))
if(s.startsWith('@shared/'))return tryFile(path.join(ROOT,'packages/shared',s.slice(8)))
if(s.startsWith('@main/'))return tryFile(path.join(ROOT,'apps/electron/src/main',s.slice(6)))
if(s.startsWith('@preload/'))return tryFile(path.join(ROOT,'apps/electron/src/preload',s.slice(9)))
if(s==='@onething/electron-host/window')return tryFile(path.join(ROOT,'apps/electron/src/window/index'))
if(s.startsWith('@onething/electron-host/'))return tryFile(path.join(ROOT,'apps/electron/src',s.slice(24)))
for(const n of Object.keys(PKGS)){if(s===n||s.startsWith(n+'/')){const sub=s===n?'':s.slice(n.length+1)
const t=resolveExports(n,sub);if(t){const g=tryFile(t);if(g)return g}
const base=n==='@onething/runtime'?path.join(ROOT,PKGS[n].dir,'src'):path.join(ROOT,PKGS[n].dir)
return tryFile(path.join(base,sub||'index'))}}
return null}
const strip=s=>s.replace(/\/\*[\s\S]*?\*\//g,m=>m.replace(/[^\n]/g,' ')).replace(/(^|[^:'"\\])\/\/[^\n]*/g,(m,p)=>p+' '.repeat(m.length-p.length))
// 语句级扫描：抓 import/export 语句头，判断是否 type-only
const RE_STMT=/^[ \t]*(import|export)\s+(type\s+)?([\s\S]*?)from\s*['"]([^'"]+)['"]/gm
const RE_SIDE=/^[ \t]*import\s*['"]([^'"]+)['"]/gm
const RE_DYN=/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g
const edges=[]
for(const f of files){let raw;try{raw=fs.readFileSync(f,'utf8')}catch{continue}
const src=strip(raw)
const li=[];{let n=1;for(let i=0;i<src.length;i++){li[i]=n;if(src[i]==='\n')n++}}
RE_STMT.lastIndex=0;let m
while((m=RE_STMT.exec(src))){const to=resolveSpec(m[4],f);if(!to)continue
// type-only: `import type X from` 或 clause 中所有 specifier 都带 `type `
let typeOnly=!!m[2]
if(!typeOnly){const clause=m[3].trim()
 const br=clause.match(/\{([\s\S]*)\}/)
 if(br){const parts=br[1].split(',').map(x=>x.trim()).filter(Boolean)
   typeOnly=parts.length>0&&parts.every(p=>/^type\s/.test(p))&&!/^[A-Za-z_$][\w$]*\s*,/.test(clause)}}
edges.push({from:f,to,spec:m[4],line:li[m.index],typeOnly,dynamic:false})}
RE_SIDE.lastIndex=0;while((m=RE_SIDE.exec(src))){const to=resolveSpec(m[1],f);if(to)edges.push({from:f,to,spec:m[1],line:li[m.index],typeOnly:false,dynamic:false})}
RE_DYN.lastIndex=0;while((m=RE_DYN.exec(src))){const to=resolveSpec(m[1],f);if(to)edges.push({from:f,to,spec:m[1],line:li[m.index],typeOnly:false,dynamic:true})}}

const idx=new Map();files.forEach((f,i)=>idx.set(f,i))
function scc(pred){const g=files.map(()=>[])
for(const e of edges){if(!pred(e))continue;const a=idx.get(e.from),b=idx.get(e.to);if(a===undefined||b===undefined||a===b)continue;g[a].push(b)}
const n=g.length,ix=new Int32Array(n).fill(-1),low=new Int32Array(n),on=new Uint8Array(n),st=[];let c=0;const comps=[]
for(let s=0;s<n;s++){if(ix[s]!==-1)continue;const w=[[s,0]]
while(w.length){const t=w[w.length-1],v=t[0]
if(t[1]===0){ix[v]=low[v]=c++;st.push(v);on[v]=1}
let rec=false
while(t[1]<g[v].length){const u=g[v][t[1]++];if(ix[u]===-1){w.push([u,0]);rec=true;break}else if(on[u])low[v]=Math.min(low[v],ix[u])}
if(rec)continue
if(low[v]===ix[v]){const comp=[];while(1){const u=st.pop();on[u]=0;comp.push(u);if(u===v)break}comps.push(comp)}
w.pop();if(w.length){const p=w[w.length-1][0];low[p]=Math.min(low[p],low[v])}}}
return comps.filter(x=>x.length>=2).sort((a,b)=>b.length-a.length)}

const total=edges.length,typeOnly=edges.filter(e=>e.typeOnly).length
console.log(`## 边总数 ${total}, 其中 import type/export type = ${typeOnly} (${(typeOnly/total*100).toFixed(1)}%)`)
for(const[label,pred]of[['全部边',()=>true],['仅值边(去掉 import type)',e=>!e.typeOnly],['仅值边且静态',e=>!e.typeOnly&&!e.dynamic]]){
const c=scc(pred);const inC=c.reduce((s,x)=>s+x.length,0)
console.log(`\n### ${label}: SCC>=2 ${c.length} 个, 最大 ${c[0]?.length||0}, 环内文件 ${inC}/${files.length} (${(inC/files.length*100).toFixed(1)}%)`)
c.slice(0,10).forEach((x,i)=>{const m={};x.forEach(v=>{const s=scopeOf(files[v])||'?';m[s]=(m[s]||0)+1})
console.log(`  #${i+1} size=${x.length} [${Object.entries(m).map(([k,v])=>k+':'+v).join(' ')}]`)
if(label!=='全部边')x.slice(0,x.length>20?20:x.length).forEach(v=>console.log(`      ${rel(files[v])}`))
if(label!=='全部边'&&x.length>20)console.log(`      ... 还有 ${x.length-20} 个`)})}
// 层间矩阵：值边
console.log('\n## 层间矩阵(仅值边)')
const names=SCOPES.map(s=>s[0]);const pair=new Map()
for(const e of edges){if(e.typeOnly)continue;const a=scopeOf(e.from),b=scopeOf(e.to);if(!a||!b)continue;const k=a+'>'+b;pair.set(k,(pair.get(k)||0)+1)}
console.log('        '+names.map(n=>n.padStart(9)).join(''))
for(const a of names)console.log(a.padEnd(8)+names.map(b=>String(pair.get(a+'>'+b)||0).padStart(9)).join(''))
