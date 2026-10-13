'use strict';
// Dedicated, immutable JSON backup I/O. No bucket provisioning, replacement,
// legacy upload helper, Roles effect ledger, or business snapshot writes.
const fail=()=>{throw Object.assign(Error('Private managed backup storage needs review.'),{code:'PDL_MANAGED_BACKUP_STORAGE'});};
async function bytes(response,maximum){
  const length=response.headers?.get?.('content-length');if(length!==null&&length!==undefined&&(!/^\d+$/.test(length)||Number(length)>maximum))fail();
  if(!response.body?.getReader)fail();const reader=response.body.getReader(),chunks=[];let total=0;
  try{for(;;){const {done,value}=await reader.read();if(done)break;total+=value.length;if(total>maximum)fail();chunks.push(Buffer.from(value));}}finally{await reader.cancel().catch(()=>{});}
  return Buffer.concat(chunks,total);
}
function createTransport(adapter){
  const request=(path,options={})=>adapter.request(path,{...options,signal:AbortSignal.timeout(30000)});
  const encoded=key=>key.split('/').map(encodeURIComponent).join('/');
  return {
    async bucket(){const r=await request('/storage/v1/bucket/tenant-backups');return JSON.parse((await bytes(r,16384)).toString());},
    async read(bucket,key,max){return bytes(await request('/storage/v1/object/'+encodeURIComponent(bucket)+'/'+encoded(key)),max);},
    async write(key,body){await request('/storage/v1/object/tenant-backups/'+encoded(key),{method:'POST',headers:{'Content-Type':'application/json','x-upsert':'false'},body});},
    async list(prefix){const out=[];for(let offset=0;offset<3200;offset+=100){
      const r=await request('/storage/v1/object/list/tenant-backups',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({prefix,limit:100,offset,sortBy:{column:'name',order:'asc'}})});
      const rows=JSON.parse((await bytes(r,256000)).toString());if(!Array.isArray(rows)||rows.length>100||rows.some(row=>typeof row?.name!=='string'))fail();out.push(...rows.map(row=>row.name));if(rows.length<100)return out;
    }fail();}
  };
}
module.exports={createTransport,bytes};
