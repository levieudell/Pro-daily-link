'use strict';
// Server-side voice transcription: POST /api/ai/transcribe accepts a base64
// audio data-URL, forwards it to the transcription endpoint as multipart FormData,
// and meters usage. Without a provider key, on provider errors, or on
// transport failure it returns 200 with source 'unavailable' so the client
// can fall back to the browser's own dictation instead of blocking the note.
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'pdl-voice-transcribe-')),companyId='33443344-3344-4344-8344-334433443344',token='synthetic-voice-transcribe-session';
const db={company:{id:companyId,name:'Synthetic transcribe',demo:true,timezone:'UTC'},projects:[],team:[],assignments:[],reports:[],photos:[],workdays:[],timeCards:[],users:[{id:1,name:'Synthetic owner',role:'owner',status:'Active',companyId}],sessions:[{companyId,userId:1,tokenHash:crypto.createHash('sha256').update(token).digest('hex'),expiresAt:'2099-01-01'}],customers:[],changes:[],catalog:[]};
const file=path.join(root,'db.json');fs.writeFileSync(file,JSON.stringify(db));fs.writeFileSync(path.join(root,'platform.json'),JSON.stringify({users:[],sessions:[]}));
Object.assign(process.env,{PDL_DB_FILE:file,PDL_PLATFORM_FILE:path.join(root,'platform.json'),PDL_REQUIRE_AUTH:'1',PDL_SUPABASE_ENABLED:'0',PDL_TRANSACTIONAL_DB:'off',PDL_EMAIL_DEV_MODE:'1'});for(const name of ['OPENAI_API_KEY','SENTRY_DSN','RESEND_API_KEY','STRIPE_SECRET_KEY','STRIPE_WEBHOOK_SECRET'])delete process.env[name];require('./database/supabase').loadLocalEnv=()=>{};
const {server}=require('./server'),nativeFetch=global.fetch;let base,mode='ok',providerCalls=[];
global.fetch=async(url,options)=>{
 if(String(url).startsWith(base+'/'))return nativeFetch(url,options);
 assert.equal(String(url),'https://api.openai.com/v1/audio/transcriptions');
 // Serialize the actual request and parse its multipart wire body, rather than
 // accepting arbitrary strings on the in-memory FormData mock.
 const request=new Request(url,options);
 assert.equal(request.method,'POST');assert.match(request.headers.get('content-type'),/^multipart\/form-data; boundary=/);
 const wire=await request.arrayBuffer();
 const form=await new Response(wire,{headers:{'Content-Type':request.headers.get('content-type')}}).formData();
 providerCalls.push({form,wire:Buffer.from(wire).toString()});
 assert.equal(form.get('model'),'gpt-transcribe');assert.equal(form.get('response_format'),'json');
 for(const legacy of ['language','languages','keywords','prompt'])assert.equal(form.has(legacy),false,legacy+' must not be sent');
 assert.equal(form.getAll('languages[]').length,1);
 assert.deepEqual(form.getAll('keywords[]'),['concrete','concreto','curb','gutter','excavation','trench','backfill','rebar','pump','slab','footing','footings','crew hours','horas','compaction','forming','sidewalk','foundation']);
 if(mode==='http-error')return{ok:false,status:503};
 if(mode==='transport-error')throw new Error('Synthetic provider connection failure');
 if(mode==='legacy-language')return{ok:true,json:async()=>({text:' Legacy transcript. ',language:'es'})};
 if(mode==='garbage')return{ok:true,json:async()=>({unexpected:true})};
 const languages=mode==='spanish'?[{code:'es'}]:mode==='undetected'?[]:mode==='malformed-language'?[{code:{unexpected:true}}]:[{code:'en'}];
 const text=mode==='spanish'?' Vaciamos concreto, tres trabajadores, ocho horas. ':' Poured the east wall, three crew, eight hours. ';
 return{ok:true,json:async()=>({text,languages,usage:{input_tokens:12,output_tokens:24}})};
};
const audioBytes=Buffer.from('synthetic-opus-audio-bytes'),dataUrl='data:audio/webm;base64,'+audioBytes.toString('base64');
async function call(route,input,sendAuth=true){const headers={'Content-Type':'application/json','x-pdl-company':companyId};if(sendAuth)headers.Authorization='Bearer '+token;const response=await fetch(base+route,{method:'POST',signal:AbortSignal.timeout(10000),headers,...(input?{body:JSON.stringify(input)}:{})});return{status:response.status,data:await response.json()}}
(async()=>{await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));base='http://127.0.0.1:'+server.address().port;try{
 const anonymous=await call('/api/ai/transcribe',{audio:dataUrl,language:'en-US'},false);assert.ok([401,404].includes(anonymous.status),'unauthenticated request is rejected');
 const noKey=await call('/api/ai/transcribe',{audio:dataUrl,language:'en-US'});assert.equal(noKey.status,200);assert.equal(noKey.data.text,'');assert.equal(noKey.data.source,'unavailable');assert.match(noKey.data.warning,/not configured/);assert.equal(providerCalls.length,0,'no provider call is made without a key');
 process.env.OPENAI_API_KEY='synthetic-provider-mock';mode='ok';
 const ok=await call('/api/ai/transcribe',{audio:dataUrl,language:'en-US'});assert.equal(ok.status,200);assert.equal(ok.data.text,'Poured the east wall, three crew, eight hours.');assert.equal(ok.data.source,'openai');assert.equal(providerCalls.length,1);
 assert.equal(ok.data.language,'en','documented language objects return a code, never [object Object]');
 const {form,wire}=providerCalls[0];assert.deepEqual(form.getAll('languages[]'),['en'],'en-US is narrowed to an ISO code in repeated multipart fields');assert.match(wire,/name="languages\[\]"/);assert.match(wire,/name="keywords\[\]"/);
 const sentFile=form.get('file');assert(sentFile&&typeof sentFile.arrayBuffer==='function','audio file is attached');assert.equal(sentFile.name,'note.webm');assert.equal(sentFile.type,'audio/webm');assert.deepEqual(Buffer.from(await sentFile.arrayBuffer()),audioBytes,'decoded audio bytes are forwarded intact');
 const usage=JSON.parse(fs.readFileSync(path.join(root,'ai-usage.json')));const today=usage.days[new Date().toISOString().slice(0,10)];assert.equal(today.features['daily-transcribe'].calls,1,'usage is metered under daily-transcribe');assert.equal(today.features['daily-transcribe'].unknownCost,true,'provider audio-token calls count with cost unknown rather than guessed');assert.equal(today.features['daily-transcribe'].input,12,'reported audio input tokens are recorded');
 mode='spanish';const spanish=await call('/api/ai/transcribe',{audio:dataUrl,language:'es-MX'});assert.equal(spanish.status,200);assert.equal(spanish.data.source,'openai');assert.equal(spanish.data.language,'es');assert.equal(spanish.data.text,'Vaciamos concreto, tres trabajadores, ocho horas.');assert.deepEqual(providerCalls.at(-1).form.getAll('languages[]'),['es']);
 mode='ok';const detected=await call('/api/ai/transcribe',{audio:dataUrl,language:'es-MX'});assert.equal(detected.data.language,'en','detected language takes precedence over the input hint');
 mode='undetected';const undetected=await call('/api/ai/transcribe',{audio:dataUrl,language:'es-MX'});assert.equal(undetected.data.language,'es','empty detected languages falls back to normalized input hint');
 mode='malformed-language';const malformedLanguage=await call('/api/ai/transcribe',{audio:dataUrl,language:'es-MX'});assert.equal(malformedLanguage.data.language,'es','non-string language codes are not coerced into object text');
 mode='legacy-language';const legacyLanguage=await call('/api/ai/transcribe',{audio:dataUrl,language:'en-US'});assert.equal(legacyLanguage.data.language,'es','legacy string language remains supported');
 mode='transport-error';const transportError=await call('/api/ai/transcribe',{audio:dataUrl,language:'en-US'});assert.equal(transportError.status,200);assert.equal(transportError.data.source,'unavailable');assert.equal(transportError.data.text,'');assert.match(transportError.data.warning,/connection failure/);
 mode='http-error';const providerError=await call('/api/ai/transcribe',{audio:dataUrl,language:'en-US'});assert.equal(providerError.status,200);assert.equal(providerError.data.source,'unavailable');assert.match(providerError.data.warning,/503/);assert.equal(providerError.data.text,'');
 mode='garbage';const malformed=await call('/api/ai/transcribe',{audio:dataUrl,language:'en-US'});assert.equal(malformed.status,200);assert.equal(malformed.data.text,'','an empty provider transcript surfaces as empty text and the client falls back');
 delete process.env.OPENAI_API_KEY;
 const badPrefix=await call('/api/ai/transcribe',{audio:'data:text/plain;base64,aGk=',language:'en-US'});assert.equal(badPrefix.status,400,'non-audio data-URL is rejected');
 const empty=await call('/api/ai/transcribe',{audio:'data:audio/webm;base64,',language:'en-US'});assert.equal(empty.status,400,'empty audio is rejected');
 console.log('Voice transcribe API: auth gate, no-key/provider-error/malformed graceful unavailability, gpt-transcribe serialized multipart contract, English/Spanish detected language objects and hint fallback, usage metering, and audio validation passed with intercepted provider transport.');
}finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));global.fetch=nativeFetch;fs.rmSync(root,{recursive:true,force:true})}})().catch(error=>{console.error(error);process.exitCode=1;server.close()});
