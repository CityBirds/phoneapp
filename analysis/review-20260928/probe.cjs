// Read-only code probes. No application server, business DB or physical printer is started.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const root = path.resolve(__dirname, '../..');
const results = [];
const elements = {};
const element = id => elements[id] ||= { value: '', innerHTML: '', style: {}, classList: { add(){}, remove(){} } };
const captured = [];
const sandbox = {
  window: { location: { origin: 'http://test.invalid' }, addEventListener(){} },
  localStorage: { getItem(){return ''}, setItem(){} },
  document: { getElementById: element }, console,
  alert: x => captured.push({alert:x}), setInterval(){return 1}, clearInterval(){},
  fetch: async (url, opts) => { captured.push({url, body: opts?.body ? JSON.parse(opts.body) : null}); return {json: async()=>({task:{id:1,files:[]}}),ok:true}; }
};
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(root,'src/frontend/app.js'),'utf8'),sandbox);
(async()=>{
  vm.runInContext("state.currentModel='DPT810'; renderTestPoints()",sandbox);
  results.push({probe:'DPT810 rows',actual:(element('test-points-body').innerHTML.match(/<tr>/g)||[]).length,expected:10});
  vm.runInContext('addPackingRow()',sandbox);
  results.push({probe:'Added packing item name',actual:vm.runInContext('state.packingItems.at(-1).name',sandbox),nameEditorPresent:/updatePackingItem\([^,]+, 'name'/.test(element('packing-items-body').innerHTML)});
  for (const [k,v] of Object.entries({'model-select':'POA200','device-sn':'NEW-SN','shipping-location':'苏州','sensor-model':'PSR-12-223(封装）','sensor-sn':'NEW-SENSOR','cert-date':'2026-09-28','tp-std-1':'9.96','tp-act-1':'9.88'})) element(k).value=v;
  vm.runInContext("state.selectedWorker={id:'offline-test',status:'OFFLINE'}; switchNavTab=()=>{}; renderPreviewLoading=()=>{}; pollTaskPreview=()=>{}",sandbox);
  await vm.runInContext('submitTaskForm()',sandbox);
  results.push({probe:'Conflicting serial and offline worker submission',actual:captured,expected:'Reject invalid worker and conflicting device serial before submission'});
  const matcher=require(path.join(root,'src/common/matcher'));
  results.push({probe:'Blank cell matched to absent label',actual:matcher.findFieldCandidates('AbsentField',[{type:'cell',text:'',tableIdx:0,rowIdx:0,colIdx:0}]),expected:'zero candidates'});
  const preview=require(path.join(root,'src/backend/preview'));
  const fake=path.join(__dirname,'not-a-word.doc');fs.writeFileSync(fake,'NOT A WORD FILE');
  const urls=preview.generateDocumentPreview(fake,path.join(__dirname,'preview-probe'),'audit_cert',{fileType:'cert',task:{id:'audit',model:'DPT-990-Ex',device_sn:'EX-TEST'},formData:{shippingLocation:'苏州',ambientTemperature:'28.7',relativeHumidity:'63.2'}});
  const svg=fs.readFileSync(path.join(__dirname,'preview-probe/preview_audit_cert-1.svg'),'utf8');
  results.push({probe:'Invalid Word still produces preview',actual:urls,hardcodedTemperature:svg.includes('23.5'),hardcodedHumidity:svg.includes('51.6'),expected:'Reject invalid Word, render actual valid document only'});
  const express=require(path.join(root,'node_modules/express'));
  const multer=require(path.join(root,'node_modules/multer'));
  const app=express();app.post('/upload',multer({storage:multer.memoryStorage()}).single('templateFile'),(req,res)=>res.json({name:req.file.originalname}));
  const server=app.listen(0,'127.0.0.1'); await new Promise(r=>server.once('listening',r));
  try {
    const filename='990-Ex-EX10260902发货证书.doc';const form=new FormData();form.append('templateFile',new Blob(['probe']),filename);
    const reply=await fetch(`http://127.0.0.1:${server.address().port}/upload`,{method:'POST',body:form});
    const data=await reply.json();results.push({probe:'Current upload middleware filename',expected:filename,actual:data.name,equal:data.name===filename});
  } finally { await new Promise(r=>server.close(r)); }
  fs.writeFileSync(path.join(__dirname,'probe-results.json'),JSON.stringify(results,null,2));
  console.log(JSON.stringify(results,null,2));
})().catch(e=>{console.error(e);process.exitCode=1});
