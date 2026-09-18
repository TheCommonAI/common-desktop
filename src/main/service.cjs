const {EventEmitter}=require('node:events'),os=require('node:os'),fs=require('node:fs'),path=require('node:path'),{spawn}=require('node:child_process'),{randomBytes}=require('node:crypto');
const {json,checkedFetch,lines,streamChat,gatewayHeaders,CLIENT}=require('./http.cjs'),{createWorker}=require('./worker.cjs'),{download,installTunnel}=require('./downloads.cjs'),identityStore=require('./identity.cjs');
const OLLAMA='http://127.0.0.1:11434';
const FALLBACK_MODELS=[{tag:'llama3.2:3b',name:'Llama 3.2 · 3B',description:'A compact general model for everyday chat.',minRam:6,estimate:'About 2 GB'},{tag:'qwen3:8b',name:'Qwen 3 · 8B',description:'A larger general model for computers with more memory.',minRam:12,estimate:'About 5.2 GB'}];
// cloudflared says why it is quitting before it goes, and the reasons want
// different answers: a rate-limited quick tunnel needs a wait, a refused
// connection needs a look at the network. "Try again" is only right for one of
// them, so carry its own last line into the status the user reads.
//
// Not every fatal line is a levelled one -- the rate-limit refusal prints as a
// bare "quick tunnel provisioning failed with status 429: error code: 1015"
// with no timestamp or ERR at all. So drop the chatter and keep the last line
// standing, rather than looking for a level that may not be there.
function helperExit(output){const line=output.split(/\r?\n/).map(l=>l.trim()).filter(l=>l&&!/^\S+\s+(?:INF|DBG)\s|^[|+\-\s]*$/.test(l)).pop(),reason=line?line.replace(/^\S+\s+(?:ERR|WRN|FTL)\s+/,'').replace(/\s+/g,' ').trim():'';if(/\b(?:429|1015)\b/.test(reason))return 'Cloudflare is rate-limiting new connections from this network. Wait a few minutes, then try again.';if(!reason)return 'The connection helper exited. Try again.';return 'The connection helper exited: '+(reason.length>200?reason.slice(0,200)+'…':reason);}
function policy(s,{battery,idleSeconds,suspended=false}){if(!s.contributing)return 'Paused';if(suspended)return 'Computer asleep';if(s.pauseBattery&&battery)return 'Paused on battery';if(s.idleOnly&&idleSeconds<s.idleMinutes*60)return 'Waiting until your computer is idle';return null;}
class Service extends EventEmitter{
 constructor(settings,{dataDir,openPath,power=()=>({battery:false,idleSeconds:0}),ollama=OLLAMA,spawnTunnel=spawn,identity=identityStore}){super();Object.assign(this,{settings,dataDir,openPath,power,ollama,spawnTunnel,identity});this.state={ollama:{online:false,models:[],running:[]},gateway:{online:false},worker:{status:'Paused',active:0,completed:0,failed:0,bytes:0},download:null,models:FALLBACK_MODELS,hardware:{},chatBusy:false};this.tail=Promise.resolve();this.closed=false;this.lastRefresh=0;}
 snapshot(){const node=this.node();return {...this.state,settings:{...this.settings.public(),name:this.nodeName(),nodeId:node?.id||null},power:this.power()};}
 emitState(){this.emit('state',this.snapshot());}
 serial(fn){const r=this.tail.then(fn);this.tail=r.catch(()=>{});return r;}
 async refresh(){if(this.refreshing)return;this.refreshing=true;try{const cpu=os.cpus(),sum=cpu.reduce((a,c)=>{a.idle+=c.times.idle;a.total+=Object.values(c.times).reduce((x,y)=>x+y,0);return a;},{idle:0,total:0});const cpuPercent=this.lastCpu&&sum.total!==this.lastCpu.total?Math.round(100*(1-(sum.idle-this.lastCpu.idle)/(sum.total-this.lastCpu.total))):null;this.lastCpu=sum;let disk=null;try{const i=fs.statfsSync(os.homedir());disk=i.bavail*i.bsize;}catch{}this.state.hardware={platform:process.platform,arch:process.arch,os:os.release(),cpu:cpu[0]?.model||'Unavailable',cores:cpu.length,cpuPercent,ram:os.totalmem(),freeRam:os.freemem(),freeDisk:disk,appMemory:process.memoryUsage().rss};const [models,version,running]=await Promise.allSettled(['/api/tags','/api/version','/api/ps'].map(p=>json(this.ollama+p,{signal:AbortSignal.timeout(2500)})));this.state.ollama={online:models.status==='fulfilled',models:models.status==='fulfilled'?models.value.models||[]:[],version:version.status==='fulfilled'?version.value.version:null,running:running.status==='fulfilled'?running.value.models||[]:[]};if(Date.now()-this.lastRefresh>30000){this.lastRefresh=Date.now();await this.refreshGateway();}this.emitState();}finally{this.refreshing=false;}}
 async refreshGateway(){const g=this.settings.value.gateway;try{await json(g+'/health',{headers:gatewayHeaders(),signal:AbortSignal.timeout(5000)});if(this.settings.value.gateway===g)this.state.gateway={online:true,checkedAt:Date.now()};}catch{if(this.settings.value.gateway===g)this.state.gateway={online:false,checkedAt:Date.now()};}}
 async catalogue(){try{const items=await json(this.settings.value.gateway+'/catalogue',{headers:gatewayHeaders(),signal:AbortSignal.timeout(5000)}),models=items.filter(m=>typeof m.source==='string'&&m.source.startsWith('ollama:')).map(m=>({tag:m.source.slice(7),name:m.display_name,description:m.capability_text,minRam:m.min_ram_gb||0,needsGpu:!!m.needs_gpu,minVram:m.min_vram_gb||0,catalogueId:m.id,domains:m.domain_tags,estimate:'Size shown during download'}));this.state.models=[...FALLBACK_MODELS,...models.filter(m=>!FALLBACK_MODELS.some(f=>f.tag===m.tag))];}catch{this.state.models=FALLBACK_MODELS;}this.emitState();return this.state.models;}
 async startOllama(){if(this.state.ollama.online)return;const candidates=process.platform==='win32'?[path.join(process.env.LOCALAPPDATA||os.homedir(),'Programs','Ollama','ollama.exe'),'ollama.exe']:process.platform==='darwin'?['/Applications/Ollama.app/Contents/Resources/ollama','/usr/local/bin/ollama','/opt/homebrew/bin/ollama','ollama']:['/usr/local/bin/ollama','/usr/bin/ollama','ollama'];for(const command of candidates){if(path.isAbsolute(command)&&!fs.existsSync(command))continue;const child=spawn(command,['serve'],{windowsHide:true,stdio:'ignore',env:{...process.env,OLLAMA_HOST:'127.0.0.1:11434'}}),started=await new Promise(r=>{child.once('error',()=>r(false));child.once('spawn',()=>r(true));});if(!started)continue;this.ownedOllama=child;child.on('exit',()=>{if(this.ownedOllama===child)this.ownedOllama=null;});for(let i=0;i<20;i++){await new Promise(r=>setTimeout(r,500));await this.refresh();if(this.state.ollama.online)return;}break;}throw new Error('Ollama has not started. Install or open Ollama, then choose Check again.');}
 async task(label,fn){if(this.downloadController)throw new Error('A download is already in progress.');const c=new AbortController();this.downloadController=c;this.state.download={label,status:'Starting',completed:0,total:null};this.emitState();const onProgress=p=>{this.state.download={...this.state.download,...p};this.emitState();};try{const result=await fn({signal:c.signal,onProgress});this.state.download={...this.state.download,status:'Complete',done:true};return result;}catch(e){this.state.download={...this.state.download,status:c.signal.aborted?'Paused — choose Download to resume':'Download failed',error:c.signal.aborted?null:e.message,done:true};if(!c.signal.aborted)throw e;}finally{this.downloadController=null;this.emitState();}}
 cancelDownload(){this.downloadController?.abort();}
 async installOllama(){if(process.platform==='linux')throw new Error('Use the Linux installation guide, then choose Check again.');const name=process.platform==='win32'?'OllamaSetup.exe':'Ollama.dmg';return this.task('Ollama installer',async options=>{const destination=path.join(this.dataDir,'downloads',name);await download('https://ollama.com/download/'+name,destination,options);options.signal.throwIfAborted();const error=await this.openPath(destination);if(error)throw new Error('Could not open the installer: '+error);});}
 prepareTunnel(){return this.task('Common connection helper',o=>installTunnel(path.join(this.dataDir,'bin'),o));}
 async pullModel(){const model=this.settings.value.model;return this.task(model,async({signal,onProgress})=>{const r=await checkedFetch(this.ollama+'/api/pull',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({model,stream:true}),signal});for await(const line of lines(r.body)){if(!line)continue;const item=JSON.parse(line);if(item.error)throw new Error('Ollama could not download this model. Check disk space and the model tag, then retry.');onProgress({status:item.status,completed:item.completed||0,total:item.total||null});}await this.refresh();if(!this.state.ollama.models.some(m=>m.name===model||m.name===model+':latest'))throw new Error('Ollama did not finish installing the model. Retry the download.');});}
 update(patch){return this.serial(async()=>{if(('gateway'in patch&&patch.gateway!==this.settings.value.gateway)||('model'in patch&&patch.model!==this.settings.value.model)||('concurrency'in patch&&patch.concurrency!==this.settings.value.concurrency))await this.stopWorker();this.settings.update(patch);this.lastRefresh=0;this.retryAfter=0;await this.reconcileInternal();this.emitState();return this.snapshot();});}
 // The node this machine is on the network, wherever it joined from: the file
 // the terminal client writes comes first, so a machine that ran `common join`
 // keeps one name and one node_token when it opens the app.
 node(gateway=this.settings.value.gateway){const shared=this.identity.forGateway(gateway);if(shared)return {id:shared.node_id,node_token:shared.node_token,name:shared.name};const own=this.settings.value.identities[gateway];return own?{...own,name:this.settings.value.name}:null;}
 nodeName(){return this.node()?.name||this.settings.value.name;}
 rememberNode(gateway,{id,node_token,name,catalogue_id=null,domain_tags=null}){this.settings.value.identities[gateway]={id,node_token};this.settings.save();this.identity.write({gateway,name,node_id:id,node_token,catalogue_id,domain_tags});}
 forgetNode(gateway){delete this.settings.value.identities[gateway];this.settings.save();this.identity.clear(gateway);}
 token(){const s=this.settings.value;return s.chatTokens[s.gateway]||this.node()?.node_token;}
 async chat({messages,target}){
  if(this.chatController)throw new Error('Wait for this answer or stop it first.');
  if(!['local','network'].includes(target))throw new Error('Choose where to send your message.');
  if(!Array.isArray(messages)||!messages.length||messages.length>100||messages.some(m=>!['user','assistant'].includes(m.role)||typeof m.content!=='string')||JSON.stringify(messages).length>512000)throw new Error('This conversation is too long. Start a new chat.');
  const c=new AbortController();this.chatController=c;this.state.chatBusy=true;this.emitState();
  const timer=setTimeout(()=>c.abort(),300000),s=this.settings.value,gateway=s.gateway,model=s.model;
  const send=()=>{const token=this.token();return streamChat(target==='local'?this.ollama+'/v1/chat/completions':gateway+'/v1/chat/completions',target==='network'?gatewayHeaders(token?{'X-Common-Node-Token':token}:{}):{},{model:target==='local'?model:'auto',messages},c.signal,d=>this.emit('chat-delta',d));};
  try{
   try{return await send();}catch(e){
    // Retry only a recognised gateway rejection BEFORE inference. Never replay
    // a prompt after a worker rejection or use a different gateway.
    if(target!=='network'||e.status!==401||e.code!=='registration_expired'||this.settings.value.chatTokens[gateway]||this.registeredGateway!==gateway||policy(this.settings.value,this.power())||c.signal.aborted)throw e;
    await this.serial(async()=>{
     if(this.settings.value.gateway!==gateway||c.signal.aborted||policy(this.settings.value,this.power()))throw e;
     await this.stopWorker();
     try{await this.startWorker();}catch(reconnectError){await this.stopWorker();throw reconnectError;}
    });
    if(this.settings.value.gateway!==gateway||c.signal.aborted)throw e;
    return await send();
   }
  }catch(e){
   if(target==='network'){this.state.gateway.chatError={status:e.status||null,code:e.code||'connection_error',origin:e.origin||'unknown'};this.emitState();}
   if(c.signal.aborted)throw new Error('Answer stopped.');throw e;
  }finally{clearTimeout(timer);this.chatController=null;this.state.chatBusy=false;this.emitState();}
 }
 cancelChat(){this.chatController?.abort();}
 reconcile(){return this.serial(()=>this.reconcileInternal());}
 async reconcileInternal(){if(this.closed)return;const reason=policy(this.settings.value,this.power());if(reason){if(this.worker)await this.stopWorker();this.state.worker.status=reason;this.emitState();return;}if(this.worker&&this.tunnel&&!this.tunnel.killed&&this.tunnel.exitCode===null&&this.state.ollama.online)return;if(this.worker)await this.stopWorker();if(this.retryAfter&&Date.now()<this.retryAfter)return;try{await this.startWorker();this.retryAfter=0;}catch(e){await this.stopWorker();this.state.worker.status=e.message;this.retryAfter=Date.now()+30000;this.emitState();}}
 async startWorker(){if(!this.state.ollama.online)await this.startOllama();const s=this.settings.value;if(!this.state.ollama.models.some(m=>m.name===s.model||m.name===s.model+':latest'))throw new Error('Download your selected model before contributing.');const executable=path.join(this.dataDir,'bin',process.platform==='win32'?'cloudflared.exe':'cloudflared');if(!fs.existsSync(executable))throw new Error('Install the connection helper in Settings to contribute.');this.state.worker.status='Connecting';this.emitState();const token=randomBytes(24).toString('base64url');this.worker=await createWorker({model:s.model,token,ollama:this.ollama,limit:s.concurrency,onStats:stats=>{this.state.worker={...this.state.worker,...stats};this.emitState();}});const tunnel=this.spawnTunnel(executable,['tunnel','--url','http://127.0.0.1:'+this.worker.port,'--no-autoupdate'],{windowsHide:true,stdio:['ignore','pipe','pipe']});this.tunnel=tunnel;const endpoint=await new Promise((resolve,reject)=>{let buffer='';const timer=setTimeout(()=>finish(new Error('Connection timed out. Check your internet connection.')),45000);const finish=(error,value)=>{clearTimeout(timer);tunnel.stdout.removeListener('data',read);tunnel.stderr.removeListener('data',read);tunnel.removeListener('error',failed);tunnel.removeListener('exit',exited);error?reject(error):resolve(value);};const read=chunk=>{buffer=(buffer+chunk.toString()).slice(-12000);const match=buffer.match(/https:\/\/(?!api\.)[a-z0-9-]+\.trycloudflare\.com/);if(match)finish(null,match[0]);},failed=()=>finish(new Error('Could not start the connection helper.')),exited=()=>finish(new Error(helperExit(buffer)));tunnel.stdout.on('data',read);tunnel.stderr.on('data',read);tunnel.once('error',failed);tunnel.once('exit',exited);});tunnel.stdout.resume();tunnel.stderr.resume();tunnel.on('error',()=>{});tunnel.once('exit',()=>{if(this.tunnel===tunnel){this.worker?.pause();this.state.worker.status='Connection interrupted — reconnecting';this.emitState();this.reconcile().catch(()=>{});}});const selected=this.state.models.find(m=>m.tag===s.model),existing=this.node(s.gateway),name=existing?.name||s.name,catalogueId=selected?.catalogueId||null,domains=selected?.domains||null,headers=gatewayHeaders({'Content-Type':'application/json'});if(existing?.node_token)headers['X-Common-Node-Token']=existing.node_token;const body=JSON.stringify({name,operator:s.operator,endpoint_url:endpoint+'/v1',model_name:s.model,capability_text:selected?.description||`${s.model}, contributed through Common Desktop.`,region:null,cost_per_1k:0,domain_tags:domains,catalogue_id:catalogueId,worker_token:token,client:CLIENT});const registration=await this.register(s.gateway,headers,body);if(!registration.id||!registration.node_token)throw new Error('The gateway did not return a node identity.');this.registeredGateway=s.gateway;this.rememberNode(s.gateway,{id:registration.id,node_token:registration.node_token,name,catalogue_id:catalogueId,domain_tags:domains});this.state.worker.status='Contributing';this.state.worker.nodeId=registration.id;this.emitState();}
 // A quick tunnel's hostname is not resolvable the moment cloudflared prints
 // it. Measured against the production gateway: public DNS answers at ~20s,
 // and the gateway accepts at ~80s -- its resolver caches the NXDOMAIN it got
 // first. The gateway resolves endpoint_url at registration time as SSRF
 // defence and 400s what it cannot resolve, so registering straight away
 // always loses that race.
 //
 // Losing it used to be fatal: reconcile tore the tunnel down, waited 30s and
 // opened a NEW tunnel with a NEW hostname, which lost again -- a contributor
 // stuck on "Connecting" forever, with nothing in the registry. So wait here,
 // on this tunnel, rather than throwing away the hostname that is about to
 // start working. Only the does-not-resolve 400 is retried; every other
 // failure still surfaces immediately.
 async register(gateway,headers,body,{attempts=12,delay=15000,sleep=ms=>new Promise(r=>setTimeout(r,ms))}={}){
  for(let i=0;;i++){
   try{return await json(gateway+'/nodes',{method:'POST',headers,body});}
   catch(e){
    if(i>=attempts-1||this.closed||!/HTTP 400/.test(e.message))throw e;
    this.state.worker.status='Waiting for the connection address to go live';this.emitState();
    await sleep(delay);
    if(this.closed)throw e;
   }
  }
 }
 async stopWorker(){const w=this.worker;this.worker=null;w?.pause();const t=this.tunnel;this.tunnel=null;t?.kill();if(w)await w.close();const g=this.registeredGateway;this.registeredGateway=null;const node=g&&this.node(g);if(node){try{await checkedFetch(`${g}/nodes/${encodeURIComponent(node.id)}`,{method:'DELETE',headers:gatewayHeaders({'X-Common-Node-Token':node.node_token}),signal:AbortSignal.timeout(5000)});this.forgetNode(g);}catch{/* Keep ownership for re-registration after an outage. */}}this.state.worker.status='Paused';this.state.worker.active=0;this.emitState();}
 async close(){this.closed=true;this.cancelChat();this.cancelDownload();await this.serial(()=>this.stopWorker());this.ownedOllama?.kill();}
}
module.exports={Service,policy,helperExit,FALLBACK_MODELS};
