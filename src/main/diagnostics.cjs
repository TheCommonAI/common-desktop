// This is the only boundary for operational data leaving memory. Unknown keys
// and arbitrary strings are dropped, not merely searched for known secrets.
const fs=require('node:fs'),path=require('node:path'),{randomUUID,createHash}=require('node:crypto');
const VERSION=require('../../package.json').version;
const EVENTS=new Set('app_started app_shutdown app_crashed renderer_failed ollama_detected ollama_start_failed gateway_reachable gateway_unreachable tunnel_starting tunnel_connected tunnel_failed registration_started registration_completed registration_failed worker_ready worker_disconnected worker_reconnecting job_received job_started first_token job_completed job_failed chat_started chat_completed chat_failed contribution_paused setup_started setup_completed setup_failed model_checked benchmark_completed update_failed'.split(' '));
const CODES=new Set('OLLAMA_NOT_INSTALLED OLLAMA_NOT_RUNNING MODEL_NOT_INSTALLED MODEL_HEALTH_FAILED GATEWAY_UNREACHABLE GATEWAY_AUTH_FAILED GATEWAY_MALFORMED TUNNEL_RATE_LIMITED TUNNEL_START_FAILED TUNNEL_TIMEOUT REGISTRATION_FAILED REGISTRATION_EXPIRED WORKER_UNREACHABLE INFERENCE_TIMEOUT INFERENCE_FAILED INFERENCE_CANCELLED UPDATE_FAILED SECURE_STORAGE_UNAVAILABLE REPORT_FAILED APP_CRASHED UNKNOWN'.split(' '));
const NUMBERS=new Set('timestamp durationMs requestStart requestDispatched inferenceStart queueDelayMs ttftMs generationMs completionTokens promptTokens totalTokens tokensPerSecond totalMs httpStatus cores ramGB jobsCompleted jobsFailed tokensGenerated inferenceMs contributionMs uptimeMs ttftCount ttftSum rateCount rateSum startedAt checkedAt active'.split(' '));
const BOOLS=new Set(['success','online','installed','accepting','unexpectedExit','available']);
const ENUMS={platform:['win32','darwin','linux'],arch:['x64','arm64','ia32'],target:['local','network'],status:['healthy','unhealthy','ready','missing','connected','disconnected','active','expired','reachable','unreachable','accepting jobs','paused','unknown','pending','running','passed','failed','skipped'],category:['network','ollama','model','tunnel','registration','inference','update','application'],stage:['application','network','gateway','ollama','model','localInference','helper','publicEndpoint','registration','worker','networkInference'],causeType:['Error','TypeError','SyntaxError','AbortError','TimeoutError','RangeError'],causeCode:['ECONNREFUSED','ENOTFOUND','ECONNRESET','ETIMEDOUT','ENOENT','EPIPE','UND_ERR_CONNECT_TIMEOUT']};
const CONTAINERS=new Set('application computer ollama models gateway node tunnel worker contribution recentEvents performance update health preferences events statistics session today allTime activity diagnostics error benchmark'.split(' '));
const MODEL=/^(?:llama[0-9.]*|qwen[0-9.]*|gemma[0-9.]*|phi[0-9.]*|mistral|deepseek-r1)(?::[0-9]+(?:\.[0-9]+)?[bm])?$/;
function modelLabel(v){return typeof v==='string'&&MODEL.test(v)?v:'custom-model';}
function sanitise(value,depth=0){if(depth>8||!value||typeof value!=='object')return {};if(Array.isArray(value))return value.slice(-200).map(v=>sanitise(v,depth+1));const out={};for(const [k,v]of Object.entries(value)){
 if(NUMBERS.has(k)){if(v===null)out[k]=null;else if(typeof v==='number'&&Number.isFinite(v)&&v>=0&&v<=1e15)out[k]=v;}
 else if(BOOLS.has(k)&&typeof v==='boolean')out[k]=v;
 else if(ENUMS[k]?.includes(v))out[k]=v;
 else if(k==='event'&&EVENTS.has(v))out[k]=v;
 else if(k==='code'&&CODES.has(v))out[k]=v;
 else if(k==='model')out[k]=modelLabel(v);
 else if(['version','ollamaVersion'].includes(k)&&typeof v==='string'&&/^\d+\.\d+\.\d+(?:-[a-z0-9.]+)?$/.test(v))out[k]=v;
 else if(k==='build'&&typeof v==='string'&&/^[a-f0-9]{7,40}$/.test(v))out[k]=v;
 else if(['installationId','workerId'].includes(k)&&typeof v==='string'&&/^[a-f0-9-]{36}$/.test(v))out[k]=v;
 else if(k==='nodeId'&&typeof v==='string'&&/^[a-f0-9]{24}$/.test(v))out[k]=v;
 else if(CONTAINERS.has(k)&&v&&typeof v==='object')out[k]=sanitise(v,depth+1);
 }return out;}
function anonymousNode(id,salt){return id?createHash('sha256').update(salt+String(id)).digest('hex').slice(0,24):null;}
function atomic(file,data){fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file+'.tmp',JSON.stringify(data),{mode:0o600});fs.renameSync(file+'.tmp',file);}
function emptyStats(){return {jobsCompleted:0,jobsFailed:0,tokensGenerated:0,inferenceMs:0,contributionMs:0,uptimeMs:0,ttftCount:0,ttftSum:0,rateCount:0,rateSum:0};}
class Diagnostics{
 constructor(dir,{version=VERSION,build=null,now=Date.now}={}){this.file=path.join(dir,'diagnostics.json');this.now=now;this.version=version;this.build=build;this.session=emptyStats();this.lastTick=now();try{this.data=JSON.parse(fs.readFileSync(this.file,'utf8'));}catch{this.data={};}this.data={installationId:randomUUID(),events:[],activity:[],allTime:emptyStats(),today:emptyStats(),day:'',...this.data};this.unexpectedExit=this.data.running===true;this.data.running=true;this.rotate();this.record('app_started');}
 rotate(){const cutoff=this.now()-7*86400000;this.data.events=this.data.events.filter(e=>e.timestamp>=cutoff).slice(-1000);this.data.activity=this.data.activity.filter(e=>e.timestamp>=cutoff).slice(-200);const day=new Date(this.now()).toLocaleDateString('en-CA');if(this.data.day!==day){this.data.day=day;this.data.today=emptyStats();}}
 save(){this.rotate();atomic(this.file,this.data);}
 record(event,fields={}){const e=sanitise({...fields,event,timestamp:this.now(),version:this.version,build:this.build});this.data.events.push(e);this.save();this.onEvent?.(e);return e;}
 tick(contributing){const now=this.now(),ms=Math.min(15000,Math.max(0,now-this.lastTick));this.lastTick=now;this.rotate();for(const s of [this.session,this.data.today,this.data.allTime]){s.uptimeMs+=ms;if(contributing)s.contributionMs+=ms;}this.save();}
 job(metrics){const m=sanitise({...metrics,timestamp:this.now()});this.rotate();this.data.activity.push(m);for(const s of [this.session,this.data.today,this.data.allTime]){s[m.success?'jobsCompleted':'jobsFailed']++;s.tokensGenerated+=m.completionTokens||0;s.inferenceMs+=m.totalMs||0;if(m.ttftMs!=null){s.ttftSum+=m.ttftMs;s.ttftCount++;}if(m.tokensPerSecond!=null){s.rateSum+=m.tokensPerSecond;s.rateCount++;}}this.save();}
 stats(){this.rotate();return {session:{...this.session},today:{...this.data.today},allTime:{...this.data.allTime}};}
 close(){this.record('app_shutdown');this.data.running=false;this.save();}
}
module.exports={sanitise,modelLabel,anonymousNode,Diagnostics,atomic,EVENTS,CODES};
