'use strict';
// Test fixture only: finite fake observations, never an HTTP/provider adapter.
function createProvider({readCompany,onAttempt=async()=>{},clock=Date.now}) {
  return async function invoke(d,proof) {
    const company=await readCompany(),outcome=await onAttempt(d,proof);if(outcome&&outcome.status!=='accepted')return outcome;
    const isFounder=company.founder?.requested===true,cycle=isFounder?company.founder.billingCycle:'monthly',plan=isFounder?company.founder.plan:'growth',price='price_synthetic_'+(isFounder?'founder_':'')+plan+'_'+cycle,start=1791504000;
    if(d.kind==='subscription')return {status:'accepted',value:{id:d.subscriptionId,customer:d.customerId,livemode:false,metadata:{company_id:d.companyId,...(isFounder?{offer:'founder'}:{})},status:'active',items:{data:[{price:{id:price},quantity:1}]},current_period_start:start,current_period_end:start+2592000,latest_invoice:isFounder?'in_synthetic_one':null,schedule:company.founder?.scheduleId||null}};
    if(d.kind==='invoice')return {status:'accepted',value:{id:d.invoiceId,customer:d.customerId,subscription:d.subscriptionId,livemode:false,status:'paid'}};
    const configured=d.kind==='configurePhases'||company.founder?.scheduleId;
    return {status:'accepted',value:{id:d.scheduleId||'sub_sched_synthetic_one',customer:d.customerId,subscription:d.subscriptionId,livemode:false,metadata:configured?{company_id:d.companyId,pdl_founder_configured:'1'}:{},phases:[{start_date:start,...(configured?{end_date:require('./founder-billing').addMonths(start,24),proration_behavior:'none'}:{}),items:[{price,quantity:1}]}],...(configured?{end_behavior:'cancel',proration_behavior:'none'}:{})}};
  };
}
module.exports={createProvider};
