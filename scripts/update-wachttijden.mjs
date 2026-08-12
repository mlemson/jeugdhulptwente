#!/usr/bin/env node
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync=promisify(execFile);
const here=path.dirname(fileURLToPath(import.meta.url));
const root=path.resolve(here,'..');
const embeddedOnly=process.argv.includes('--embedded-only');
const html=await fs.readFile(path.join(root,'index.html'),'utf8');
const scripts=[...html.matchAll(/<script>([\s\S]*?)<\/script>/gi)];
if(!scripts.length)throw new Error('Geen inline script gevonden in index.html');
const code=scripts.at(-1)[1];
const MAX_BYTES=12*1024*1024;
const REMOTE_TIMEOUT_MS=20000;
const nativeFetch=globalThis.fetch;

class FakeElement{
  constructor(id){
    this.id=id;
    this.value=id==='offerType'?'__regular__':'';
    this.innerHTML='';this.textContent='';this.hidden=false;this.disabled=false;
    this.className='';this.title='';
  }
  addEventListener(){} showModal(){} close(){}
}
const elements=new Map();
const getElement=selector=>{
  const id=String(selector).replace(/^#/,'');
  if(!elements.has(id))elements.set(id,new FakeElement(id));
  return elements.get(id);
};
const storage=new Map();

function jsonResponse(payload,status=200){
  return new Response(JSON.stringify(payload),{status,headers:{'content-type':'application/json; charset=utf-8'}});
}
function decodeEntities(text){
  const named={nbsp:' ',amp:'&',lt:'<',gt:'>',quot:'"',apos:"'",euro:'€',ndash:'–',mdash:'—'};
  return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi,(all,key)=>{
    if(key[0]==='#'){
      const hex=key[1]?.toLowerCase()==='x';
      const value=parseInt(key.slice(hex?2:1),hex?16:10);
      return Number.isFinite(value)?String.fromCodePoint(value):all;
    }
    return named[key.toLowerCase()]??all;
  });
}
function normalizeText(text){
  return decodeEntities(text)
    .replace(/\r\n?/g,'\n')
    .replace(/[\t\u00a0 ]+/g,' ')
    .replace(/ *\n */g,'\n')
    .replace(/\n{3,}/g,'\n\n')
    .trim();
}
function extractHtml(raw,finalUrl){
  const titleMatch=raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title=titleMatch?normalizeText(titleMatch[1].replace(/<[^>]+>/g,' ')):'';
  const links=[];
  for(const match of raw.matchAll(/href\s*=\s*["']([^"']+)["']/gi)){
    try{
      const absolute=new URL(match[1],finalUrl).href;
      if(/^https?:/i.test(absolute))links.push(absolute);
    }catch{}
  }
  let text=raw
    .replace(/<(script|style|noscript|svg|canvas)\b[^>]*>[\s\S]*?<\/\1>/gi,' ')
    .replace(/<br\s*\/?\s*>/gi,'\n')
    .replace(/<\/(?:td|th)>/gi,'\t')
    .replace(/<\/(?:p|div|li|tr|h[1-6]|section|article|table|ul|ol)>/gi,'\n')
    .replace(/<[^>]+>/g,' ');
  return {text:normalizeText(text),links:[...new Set(links)],title};
}
async function extractPdf(buffer){
  const temp=path.join(os.tmpdir(),`wachtlijsten-${process.pid}-${Date.now()}.pdf`);
  await fs.writeFile(temp,buffer);
  const program=[
    'from pathlib import Path',
    'from pypdf import PdfReader',
    `p=Path(${JSON.stringify(temp)})`,
    'r=PdfReader(str(p))',
    'print("\\n".join((page.extract_text() or "") for page in r.pages))',
  ].join(';');
  try{
    const {stdout}=await execFileAsync('python',['-c',program],{cwd:root,maxBuffer:16*1024*1024,timeout:30000});
    return normalizeText(stdout);
  }finally{await fs.unlink(temp).catch(()=>{});}
}
function combinedAbort(outerSignal,timeoutMs){
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),timeoutMs);
  const abort=()=>controller.abort();
  if(outerSignal){
    if(outerSignal.aborted)controller.abort();
    else outerSignal.addEventListener('abort',abort,{once:true});
  }
  return {signal:controller.signal,cleanup:()=>{clearTimeout(timer);outerSignal?.removeEventListener?.('abort',abort)}};
}
async function fetchRemoteDoc(requestedUrl,outerSignal){
  const temp=path.join(os.tmpdir(),`wachtlijsten-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.bin`);
  const {signal,cleanup}=combinedAbort(outerSignal,REMOTE_TIMEOUT_MS+2000);
  try{
    const args=[
      '--location','--silent','--show-error','--fail',
      '--connect-timeout','10','--max-time',String(Math.ceil(REMOTE_TIMEOUT_MS/1000)),
      '--retry','2','--retry-delay','1','--retry-all-errors',
      '--max-filesize',String(MAX_BYTES),
      '--user-agent','Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 WachtlijstenTwente/33',
      '--header','Accept: text/html,application/xhtml+xml,application/pdf,text/plain;q=0.9,*/*;q=0.7',
      '--header','Accept-Language: nl-NL,nl;q=0.9,en;q=0.5',
      '--output',temp,
      '--write-out','%{url_effective}\n%{content_type}\n%{http_code}',
      requestedUrl,
    ];
    const {stdout}=await execFileAsync('curl',args,{maxBuffer:1024*1024,timeout:REMOTE_TIMEOUT_MS+4000,signal});
    const lines=stdout.trim().split(/\r?\n/);
    const httpCode=Number(lines.pop());
    const contentType=(lines.pop()||'').split(';')[0].trim().toLowerCase();
    const finalUrl=lines.join('\n')||requestedUrl;
    if(!Number.isFinite(httpCode)||httpCode<200||httpCode>=400)throw new Error(`Bron gaf HTTP ${httpCode||'onbekend'}`);
    const buffer=await fs.readFile(temp);
    if(buffer.length>MAX_BYTES)throw new Error('Bron is groter dan de veiligheidslimiet');
    let text='',links=[],title='';
    if(contentType==='application/pdf'||/\.pdf(?:$|\?)/i.test(finalUrl)){
      text=await extractPdf(buffer);
    }else if(contentType.includes('html')||buffer.subarray(0,1000).toString('utf8').toLowerCase().includes('<html')){
      ({text,links,title}=extractHtml(buffer.toString('utf8'),finalUrl));
    }else{
      text=normalizeText(buffer.toString('utf8'));
    }
    return {ok:true,requested_url:requestedUrl,final_url:finalUrl,content_type:contentType,title,text,links,fetched_at:new Date().toISOString(),cached:false};
  }catch(error){
    if(error?.name==='AbortError'||error?.code==='ABORT_ERR'||error?.killed)throw new Error('Broncontrole duurde te lang');
    throw new Error(String(error?.stderr||error?.message||error).trim().slice(0,500));
  }finally{cleanup();await fs.unlink(temp).catch(()=>{});}
}

const wrappedFetch=async(input,init={})=>{
  const raw=typeof input==='string'?input:input.url;
  if(raw==='/api/health')return jsonResponse({ok:true,version:33});
  if(raw.startsWith('/api/text?')){
    const requestUrl=new URL(raw,'http://127.0.0.1').searchParams.get('url');
    if(!requestUrl)return jsonResponse({ok:false,error:'URL ontbreekt'},400);
    try{return jsonResponse(await fetchRemoteDoc(requestUrl,init.signal));}
    catch(error){return jsonResponse({ok:false,error:error.message,url:requestUrl},502);}
  }
  if(raw.startsWith('./wachtlijsten_data.json')){
    if(embeddedOnly)return jsonResponse({ok:false,error:'Embedded modus'},404);
    try{return jsonResponse(JSON.parse(await fs.readFile(path.join(root,'wachtlijsten_data.json'),'utf8')));}
    catch{return jsonResponse({ok:false,error:'Nog geen JSON'},404);}
  }
  return nativeFetch(raw,init);
};

const context={
  console,URL,Date,Intl,Set,Map,Array,Object,String,Number,Boolean,RegExp,Math,JSON,Promise,
  setTimeout,clearTimeout,setInterval,clearInterval,AbortController,
  fetch:wrappedFetch,alert:()=>{},WACHTLIJSTEN_SKIP_FOLLOW:true,
  location:{protocol:'http:',hostname:'127.0.0.1',href:'http://127.0.0.1/'},
  document:{querySelector:getElement},
  localStorage:{getItem:k=>storage.get(k)??null,setItem:(k,v)=>storage.set(k,String(v)),removeItem:k=>storage.delete(k)},
};
context.window=context;context.globalThis=context;
vm.createContext(context);
vm.runInContext(code,context,{filename:'index-inline.js'});
await context.WachtlijstenApp.initPromise;
let progressTimer=null;
if(!embeddedOnly){
  progressTimer=setInterval(()=>console.log(`[voortgang] ${getElement('#statusText').textContent}`),10000);
  await context.WachtlijstenApp.refreshSources();
  clearInterval(progressTimer);
}
const rows=context.WachtlijstenApp.getData().map(row=>{
  const cleaned={...row};
  delete cleaned.rid;delete cleaned.sources;delete cleaned.ws;delete cleaned.mergedCount;
  return cleaned;
});
if(!Array.isArray(rows)||rows.length<20)throw new Error(`Onverwacht weinig regels: ${rows.length}`);
const generatedAt=new Date().toISOString();
const payload={
  schemaVersion:1,generatedAt,rows,
  summary:embeddedOnly?'Initiële ingebouwde gegevens gepubliceerd.':context.WachtlijstenApp.getSummary(),
  report:embeddedOnly?'Nog geen automatische broncontrole uitgevoerd.':context.WachtlijstenApp.getReport(),
};
await fs.writeFile(path.join(root,'wachtlijsten_data.json'),JSON.stringify(payload,null,2)+'\n','utf8');
console.log(`wachtlijsten_data.json geschreven: ${rows.length} regels (${generatedAt})`);
process.exit(0);
