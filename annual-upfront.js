'use strict';
const crypto=require('node:crypto');
const VERSION='annual-upfront-first-year-v1';
const amounts={starter:{first:891,renewal:990},growth:{first:1791,renewal:1990},pro:{first:3591,renewal:3990}};
const fail=(message,statusCode=400)=>Object.assign(new Error(message),{statusCode});
const configured=(env=process.env)=>Boolean(env.STRIPE_FIRST_YEAR_ANNUAL_COUPON&&env.STRIPE_SECRET_KEY&&env.STRIPE_WEBHOOK_SECRET);
function enroll(input,env=process.env){
  if(input.annualUpfront!==true)return null;
  if(!configured(env))throw fail('Upfront annual offer is not connected yet.',503);
  if(input.billingCycle!=='annual'||!amounts[input.plan]||input.annualUpfrontTermsAccepted!==true)throw fail('Choose annual billing and accept the upfront payment and renewal terms.');
  if(String(input.founderCode||'').trim()||input.assistedSetup||input.discountPercent||input.promotionCode)throw fail('The upfront annual offer cannot be combined with another offer.');
  return {version:VERSION,plan:input.plan,acceptedAt:new Date().toISOString(),used:false};
}
async function checkout(company,input,request,env=process.env){
  const offer=company.annualUpfront;
  if(!offer||offer.used)return {};
  if(offer.version!==VERSION||input.plan!==offer.plan||input.billingCycle!=='annual'||company.founder||company.billingExempt||company.discountPercent||company.stripeTrialUsed||company.stripeSubscriptionId||company.retiredStripeSubscriptionIds?.length)throw fail('This upfront annual offer is only available with the original new-customer selection.',409);
  if(!configured(env))throw fail('Upfront annual offer is temporarily unavailable.',503);
  const coupon=await request('/coupons/'+encodeURIComponent(env.STRIPE_FIRST_YEAR_ANNUAL_COUPON),null,'GET');
  if(coupon.id!==env.STRIPE_FIRST_YEAR_ANNUAL_COUPON||coupon.livemode!==/^(sk|rk)_live_/.test(env.STRIPE_SECRET_KEY)||coupon.valid!==true||coupon.duration!=='once'||coupon.percent_off!==10||coupon.amount_off!=null||coupon.max_redemptions!=null||coupon.redeem_by!=null||coupon.applies_to?.products?.length)throw fail('The upfront annual discount configuration does not match this offer.',503);
  if(company.stripeCustomerId){const customer=await request('/customers/'+encodeURIComponent(company.stripeCustomerId),null,'GET');if(customer.id!==company.stripeCustomerId||customer.livemode!==coupon.livemode||customer.deleted||customer.discount||customer.discounts?.length||customer.balance)throw fail('Customer billing requires support review before applying this offer.',409);}
  const a=amounts[offer.plan];
  return {integration_identifier:'annual_upfront_'+Array.from(crypto.randomBytes(8),n=>String.fromCharCode(97+n%26)).join(''),'discounts[0][coupon]':coupon.id,'metadata[offer]':VERSION,'subscription_data[metadata][offer]':VERSION,'custom_text[submit][message]':`Pay $${a.first.toLocaleString('en-US')} today for your first year. No free trial. Renews automatically at $${a.renewal.toLocaleString('en-US')} per year until cancelled. Taxes, if applicable, are additional.`};
}
async function fulfill(db,subscription,info,request){
  const accepted=db.company.annualUpfront;
  if(accepted&&(!accepted.used||accepted.subscriptionId===subscription.id&&!accepted.paidAt)&&subscription.metadata?.offer!==VERSION)throw fail('Upfront annual subscription is missing the accepted offer.',409);
  if(subscription.metadata?.offer!==VERSION)return;
  const offer=db.company.annualUpfront,a=amounts[info.plan];
  // After verified first payment, ordinary provider lifecycle/portal changes apply.
  // Never let the historical signup offer block cancellation or past-due status.
  if(offer?.used&&offer.paidAt&&offer.subscriptionId===subscription.id&&
      (subscription.status!=='active'||info.plan!==offer.plan||info.cycle!=='annual'))return;
  if(!offer||offer.version!==VERSION||offer.plan!==info.plan||info.founder||info.cycle!=='annual'||subscription.metadata.company_id!==String(db.company.id)||subscription.trial_end||subscription.trial_start)throw fail('Upfront annual subscription does not match the accepted offer.');
  if(subscription.status==='active'){
    const id=typeof subscription.latest_invoice==='string'?subscription.latest_invoice:subscription.latest_invoice?.id;
    const invoice=id?await request('/invoices/'+encodeURIComponent(id),null,'GET'):null;
    if(offer.paidAt&&offer.used&&offer.subscriptionId===subscription.id&&invoice?.billing_reason==='subscription_update'&&invoice.id===id&&invoice.status==='paid'&&invoice.customer===(typeof subscription.customer==='string'?subscription.customer:subscription.customer?.id)&&invoice.livemode===subscription.livemode&&invoice.currency==='usd'&&(invoice.subscription||invoice.parent?.subscription_details?.subscription)===subscription.id)return;
    const first=invoice?.billing_reason==='subscription_create',expected=(first?a.first:a.renewal)*100;
    let recoveredFirst=null;
    if(!offer.paidAt&&!first){
      let cursor=null,complete=false;
      for(let page=0;page<100;page++){
        const query=new URLSearchParams({subscription:subscription.id,limit:'100',...(cursor?{starting_after:cursor}:{})});
        const history=await request('/invoices?'+query,null,'GET');
        if(!Array.isArray(history?.data)||typeof history.has_more!=='boolean')throw fail('Unable to verify annual invoice history.',409);
        for(const item of history.data){
          if(item.billing_reason!=='subscription_create')continue;
          if(recoveredFirst&&recoveredFirst.id!==item.id)throw fail('Annual invoice history is ambiguous.',409);
          recoveredFirst=item;
        }
        if(!history.has_more){complete=true;break;}
        const next=history.data.at(-1)?.id;
        if(!next||next===cursor)throw fail('Unable to verify annual invoice history.',409);
        cursor=next;
      }
      if(!complete||!recoveredFirst?.id)throw fail('The discounted first annual invoice must be verified before activation.',409);
      const recoveredId=recoveredFirst.id;
      recoveredFirst=await request('/invoices/'+encodeURIComponent(recoveredId),null,'GET');
      if(recoveredFirst?.id!==recoveredId)throw fail('Annual invoice identity does not match.',409);
      const firstSub=recoveredFirst?.subscription||recoveredFirst?.parent?.subscription_details?.subscription;
      const customer=typeof subscription.customer==='string'?subscription.customer:subscription.customer?.id;
      if(!recoveredFirst||recoveredFirst.billing_reason!=='subscription_create'||recoveredFirst.livemode!==subscription.livemode||recoveredFirst.currency!=='usd'||firstSub!==subscription.id||recoveredFirst.customer!==customer||recoveredFirst.status!=='paid'||recoveredFirst.subtotal!==a.renewal*100||recoveredFirst.total_excluding_tax!==a.first*100||recoveredFirst.amount_paid<a.first*100||recoveredFirst.amount_remaining!==0||(recoveredFirst.total_discount_amounts||[]).reduce((n,d)=>n+d.amount,0)!==(a.renewal-a.first)*100||offer.firstInvoiceId&&offer.firstInvoiceId!==recoveredFirst.id)throw fail('The discounted first annual invoice must be verified before activation.',409);
    }
    if(first&&offer.firstInvoiceId&&offer.firstInvoiceId!==id)throw fail('The discounted first annual invoice must be verified before activation.',409);
    const invoiceSub=invoice?.subscription||invoice?.parent?.subscription_details?.subscription;
    const customer=typeof subscription.customer==='string'?subscription.customer:subscription.customer?.id;
    if(!invoice||invoice.id!==id||invoice.livemode!==subscription.livemode||invoice.currency!=='usd'||invoiceSub!==subscription.id||invoice.customer!==customer||invoice.status!=='paid'||invoice.subtotal!==a.renewal*100||invoice.total_excluding_tax!==expected||invoice.amount_paid<expected||invoice.amount_remaining!==0)throw fail('Waiting for a verified upfront annual invoice payment.',409);
    const discounts=(invoice.total_discount_amounts||[]).reduce((n,d)=>n+d.amount,0);
    if(discounts!==(first?(a.renewal-a.first)*100:0))throw fail('Annual invoice discount does not match the accepted offer.',409);
    if((first||recoveredFirst)&&!offer.firstInvoiceId)offer.firstInvoiceId=recoveredFirst?.id||invoice.id;
    offer.paidAt ||= new Date().toISOString();info.amount=expected/100;
  }
  offer.used=true;offer.subscriptionId=subscription.id;
}
module.exports={VERSION,amounts,configured,enroll,checkout,fulfill};
