const http=require('node:http'),{timingSafeEqual}=require('node:crypto'),{once}=require('node:events');
const {Performance}=require('./performance.cjs');
function equal(a,b){const x=Buffer.from(a||''),y=Buffer.from(b);return x.length===y.length&&timingSafeEqual(x,y);}
async function createWorker({model,token,ollama='http://127.0.0.1:11434',limit=1,onStats=()=>{},onEvent=()=>{},onJob=()=>{},timeoutMs=300000}){
 let accepting=true;const active=new Set(),stats={active:0,completed:0,failed:0,bytes:0,lastJobMs:null,startedAt:Date.now()},notify=()=>onStats({...stats});
 const server=http.createServer(async(req,res)=>{
  const fail=(code,message)=>{res.writeHead(code,{'Content-Type':'application/json'});res.end(JSON.stringify({error:message}));};
  if(!equal(req.headers.authorization,`Bearer ${token}`))return fail(401,'Authentication required');
  if(req.method==='GET'&&req.url==='/v1/models'){res.setHeader('Content-Type','application/json');return res.end(JSON.stringify({object:'list',data:[{id:model,object:'model',owned_by:'common'}]}));}
  if(req.method!=='POST'||req.url!=='/v1/chat/completions')return fail(404,'Unknown route');
  if(!accepting||active.size>=limit)return fail(503,'Worker is paused or busy');
  const controller=new AbortController(),timing=new Performance({model});active.add(controller);stats.active=active.size;notify();onEvent('job_received',{model});let finished=false,valid=false,code='INFERENCE_FAILED',nonstream='';
  const timer=setTimeout(()=>{code='INFERENCE_TIMEOUT';controller.abort();},timeoutMs);res.on('close',()=>{if(!finished)controller.abort();});const abortInput=()=>req.destroy();controller.signal.addEventListener('abort',abortInput,{once:true});
  try{
   const chunks=[];let size=0;for await(const c of req){size+=c.length;if(size>1024*1024){fail(413,'Request too large');return;}chunks.push(c);}controller.signal.removeEventListener('abort',abortInput);
   let data;try{data=JSON.parse(Buffer.concat(chunks).toString());}catch{return fail(400,'Invalid JSON');}
   if(!data||data.model!==model||!Array.isArray(data.messages))return fail(400,'Use the configured model and a messages array');valid=true;
   timing.start();onEvent('job_started',{model});
   const r=await fetch(ollama+'/v1/chat/completions',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...data,...(data.stream?{stream_options:{include_usage:true}}:{})}),signal:controller.signal,redirect:'error'});
   if(!r.ok){await r.body?.cancel();throw new Error('Local inference failed');}
   res.writeHead(200,{'Content-Type':data.stream?'text/event-stream':'application/json','Cache-Control':'no-cache'});
   for await(const c of r.body){stats.bytes+=c.length;const before=timing.m.ttftMs;if(data.stream)timing.feed(c);else{nonstream+=timing.decoder.decode(c,{stream:true});if(nonstream.length>4*1024*1024)throw new Error('Oversized response');}if(before===null&&timing.m.ttftMs!==null)onEvent('first_token',{model,ttftMs:timing.m.ttftMs});if(!res.write(c))await once(res,'drain',{signal:controller.signal});}
   if(!data.stream){timing.item(JSON.parse(nonstream));timing.m.ttftMs=null;}
   if(!timing.completed)throw new Error('Incomplete response');finished=true;res.end();stats.completed++;stats.lastJobMs=Date.now()-timing.m.requestStart;
  }catch{if(!res.headersSent&&!res.destroyed)fail(502,'Local inference stopped');else res.destroy();}
  finally{clearTimeout(timer);active.delete(controller);stats.active=active.size;if(valid){if(!finished)stats.failed++;const m={...timing.finish(finished),...(!finished?{code}: {})};onEvent(finished?'job_completed':'job_failed',m);onJob(m);}notify();}
 });server.requestTimeout=30000;server.headersTimeout=15000;server.listen(0,'127.0.0.1');await once(server,'listening');return {port:server.address().port,stats,pause(){accepting=false;for(const c of active)c.abort();},async close(){this.pause();server.closeAllConnections();await new Promise(r=>server.close(r));}};
}
module.exports={createWorker};
