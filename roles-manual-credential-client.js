'use strict';
(function(){
 const uuid=()=>crypto.randomUUID();
 function create(call){
  const pending=new Map();
  const identity=async()=>{const value=await call('/api/platform/auth/me');if(!value.manualCredentialCustody)return null;if(value.role!=='platform_owner'||!Number.isSafeInteger(value.id)||!/^[a-f0-9]{64}$/.test(value.accountSessionBinding||''))throw Error('Current platform Owner session required.');return JSON.stringify([value.id,value.role,value.email,value.accountSessionBinding]);};
  return async function request(route,options={}){
   if(options.method!=='POST'||!(route==='/api/platform/users'||/^\/api\/platform\/companies\/[^/]+\/owner-reset$/.test(route)))return call(route,options);
   const scope=await identity();if(!scope){if(pending.size)throw Error('Review original setup operation '+pending.values().next().value.operationId+' before changing credential workflow mode.');return call(route,options);}const input=JSON.parse(options.body||'{}'),plan=JSON.stringify([route,input]);
   let original=pending.get(route);const detached=[...pending.entries()].find(([path])=>path!==route);if(detached)throw Error('Review original setup operation '+detached[1].operationId+' before submitting a different account request.');if(original&&(original.scope!==scope||original.plan!==plan))throw Error('Review original setup operation '+original.operationId+' before submitting a different account request.');
   const fresh=async()=>{if(await identity()!==scope||options.manualAccept&&options.manualAccept()!==true)throw Error('Current account or form changed. Review original setup operation '+original.operationId+'.');};
   const recover=async()=>{const path=route==='/api/platform/users'?'/api/platform/manual-credentials/'+original.operationId:route+'/'+original.operationId,result=await call(path);await fresh();if(result.operationId!==original.operationId||typeof result.setupCode!=='string')throw Error('Original setup result needs review.');pending.delete(route);return result;};
   if(original)return recover();original={operationId:uuid(),scope,plan};pending.set(route,original);
   let dispatched=false;
   try{await fresh();const {manualAccept,...dispatch}=options;dispatched=true;const result=await call(route,{...dispatch,headers:{...(options.headers||{}),'X-PDL-Operation':original.operationId}});await fresh();if(result.operationId!==original.operationId||typeof result.setupCode!=='string')throw Error('Original setup result needs review.');pending.delete(route);return result;}
   catch(error){if(!dispatched){pending.delete(route);throw error;}try{return await recover();}catch(recoveryError){if([400,403,409].includes(error.status)&&recoveryError.status===404)pending.delete(route);throw Error('Review original setup operation '+original.operationId+'. Use this same request to read its result; it will not issue a replacement. '+error.message);}}
  };
 }
 if(typeof module!=='undefined'&&module.exports){module.exports={create};return;}
 api=create(api);
})();
