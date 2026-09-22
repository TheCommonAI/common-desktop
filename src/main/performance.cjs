// Parse timing/usage only. Content is observed to locate the first token and
// then discarded. No response text is retained in this object.
class Performance{
 constructor({model,now=Date.now}={}){this.now=now;this.m={model,requestStart:now(),inferenceStart:null,queueDelayMs:null,ttftMs:null,generationMs:null,completionTokens:null,promptTokens:null,totalTokens:null,tokensPerSecond:null,totalMs:null};this.buffer='';this.decoder=new TextDecoder();this.completed=false;}
 // Dispatch is observable; the actual model start and internal queue are not.
 start(){this.m.requestDispatched=this.now();}
 item(p){if(p.error)throw new Error('Inference error');const text=p.choices?.[0]?.delta?.content||p.choices?.[0]?.message?.content||p.message?.content||p.response;if(text&&this.m.ttftMs===null)this.m.ttftMs=this.now()-this.m.requestStart;if(p.done||p.choices?.some(c=>c.finish_reason!=null))this.completed=true;const usage=p.usage||{};for(const [key,v]of [['completionTokens',usage.completion_tokens??p.eval_count],['promptTokens',usage.prompt_tokens??p.prompt_eval_count],['totalTokens',usage.total_tokens]])if(Number.isInteger(v)&&v>=0)this.m[key]=v;if(typeof p.eval_duration==='number'&&p.eval_duration>0){this.m.generationMs=p.eval_duration/1e6;if(this.m.completionTokens!==null)this.m.tokensPerSecond=this.m.completionTokens/(p.eval_duration/1e9);}}
 feed(chunk){this.buffer+=this.decoder.decode(chunk,{stream:true});if(this.buffer.length>4*1024*1024)throw new Error('Oversized inference event');let i;while((i=this.buffer.indexOf('\n'))>=0){const line=this.buffer.slice(0,i).trim();this.buffer=this.buffer.slice(i+1);if(!line.startsWith('data:'))continue;const data=line.slice(5).trim();if(data==='[DONE]')this.completed=true;else if(data)this.item(JSON.parse(data));}}
 finish(success){this.m.totalMs=this.now()-this.m.requestStart;if(this.m.generationMs===null&&this.m.ttftMs!==null){this.m.generationMs=Math.max(0,this.m.totalMs-this.m.ttftMs);if(this.m.completionTokens>1&&this.m.generationMs>0)this.m.tokensPerSecond=(this.m.completionTokens-1)/(this.m.generationMs/1000);}return {...this.m,success};}
}
module.exports={Performance};
