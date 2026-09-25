import { chromium } from 'playwright'
const b = await chromium.launch()
const p = await b.newPage({ viewport:{width:1720,height:1200}, deviceScaleFactor:2 })
await p.goto('file:///Users/yitiansong/data/code/start-electron/assets/diagrams/system-architecture.html')
await p.evaluate(() => document.fonts.ready)
await p.waitForTimeout(400)
const r = await p.evaluate(() => {
  const W=1720,H=1200, bad=[]
  document.querySelectorAll('body *').forEach(el=>{
    const x=el.getBoundingClientRect()
    if(x.width===0&&x.height===0) return
    if(x.left<-0.5||x.top<-0.5||x.right>W+0.5||x.bottom>H+0.5)
      bad.push(el.tagName+'.'+el.className+' ['+[x.left,x.top,x.right,x.bottom].map(Math.round).join(',')+']')
  })
  return {overflow:bad, scroll:[document.body.scrollWidth,document.body.scrollHeight],
    bands:[...document.querySelectorAll('.band')].map(e=>{const x=e.getBoundingClientRect();return e.querySelector('h2').textContent+' '+Math.round(x.top)+'-'+Math.round(x.bottom)}),
    hosts:[...document.querySelectorAll('.host')].map(e=>{const x=e.getBoundingClientRect();return Math.round(x.left)+'..'+Math.round(x.right)}),
    dirs:[...document.querySelectorAll('.dir-body .end')].map(e=>e.textContent)}
})
console.log(JSON.stringify(r,null,1))
await b.close()
