// Local-only preview. Optional --snapshot /path/to/captured-demo.json loads a
// read-only live snapshot; nothing here forwards requests or telemetry to production.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import handler from '../api/demo.js';
import { __setRepoForTests } from '../lib/sheets.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
const snapshotArg = process.argv.indexOf('--snapshot');
const snapshot = snapshotArg >= 0 ? JSON.parse(await readFile(process.argv[snapshotArg+1], 'utf8')) : null;
const strong = JSON.parse(await readFile(new URL('./fixtures/strong-handling-probe.json', import.meta.url),'utf8'));
const rows = [
  { demo_slug:'preview-strong', demo_status:'ready', agency_name:strong.agency_name, ...strong.probe, enquiry_at:strong.probe.probe_timestamp, seller_declared:'yes' },
  { demo_slug:'preview-sparse', demo_status:'ready', agency_name:'Example Independent Estate Agents', probe_id:'prb_sparse', property_address:'Example Road', enquiry_at:'2026-08-17T22:39:00Z' },
];
const probes = [strong.probe];
const communications = [5,12,25,50,75].map((min,i) => ({ communication_id:'test_'+i, agency_id:strong.probe.agency_id, probe_id:strong.probe.probe_id, direction:'inbound', match_status:'matched', channel:i===1?'phone':'email', occurred_at:new Date(Date.parse(strong.probe.probe_timestamp)+min*60000).toISOString() }));
if (snapshot) { rows.push({...snapshot.demo,...snapshot.source?.probe,demo_status:'ready'}); probes.push(snapshot.source?.probe || {}); communications.push(...(snapshot.communications || [])); }
const header = [...new Set(rows.flatMap(row=>Object.keys(row)))];
__setRepoForTests({
  getTable: async tab => tab === 'DEMOS' ? {header,rows:rows.map(row=>header.map(key=>row[key]??''))} : {header:[],rows:[]},
  getRecords: async tab => (tab === 'PROBES' ? probes : tab === 'COMMUNICATIONS' ? communications : []).map(obj=>({obj})),
  writeCellsBatch: async () => {}, updateCell: async () => {},
});
const types={'.html':'text/html','.css':'text/css','.js':'text/javascript','.png':'image/png'};
createServer(async(req,res)=>{
  const url=new URL(req.url,'http://localhost');
  if(url.pathname==='/api/demo'){
    if(req.method==='POST'){res.writeHead(200,{'Content-Type':'application/json'}).end('{"ok":true,"local_preview":true}');return;}
    req.query=Object.fromEntries(url.searchParams);req.query.preview='1';
    res.status=code=>{res.statusCode=code;return res;};res.json=data=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify(data));};
    await handler(req,res);return;
  }
  const path=decodeURIComponent(url.pathname);
  let file;
  if(path.startsWith('/assets/')) file=resolve(root,'site',path.slice(1));
  else if(path==='/' || path==='/demo.html' || /^\/(?:demo\/)?[a-z0-9-]+$/.test(path)) file=resolve(root,'demo.html');
  if(!file || !(file===resolve(root,'demo.html') || file.startsWith(resolve(root,'site/assets')+sep))){res.writeHead(404).end();return;}
  try{const body=await readFile(file);res.writeHead(200,{'Content-Type':types[extname(file)]||'application/octet-stream','Cache-Control':'no-store'}).end(body);}catch{res.writeHead(404).end();}
}).listen(4311,'127.0.0.1',()=>console.log('NOVUS demo → http://127.0.0.1:4311/'+(snapshot?.demo?.demo_slug || 'preview-strong')+'?preview=1'));
