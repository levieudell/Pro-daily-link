function reportWorkDate(report){
  const iso=String(report?.dateIso||'');
  if(/^\d{4}-\d{2}-\d{2}$/.test(iso)){
    const [year,month,day]=iso.split('-').map(Number);
    const date=new Date(Date.UTC(year,month-1,day));
    return {
      iso,
      short:date.toLocaleDateString('en-US',{month:'short',day:'numeric',timeZone:'UTC'}),
      long:date.toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric',timeZone:'UTC'})
    };
  }
  const fallback=String(report?.date||'');
  return {iso:'',short:fallback,long:fallback};
}

function reportSubmittedOn(report){
  const submitted=(report?.history||[]).find(row=>/^submitted/i.test(String(row.action||'')));
  if(!submitted?.at)return null;
  const date=new Date(submitted.at);
  if(Number.isNaN(date.valueOf()))return null;
  return {
    iso:date.toISOString().slice(0,10),
    label:date.toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric',timeZone:'UTC'})
  };
}

function reportsByWorkDate(list){
  return [...(list||[])].sort((a,b)=>{
    const ad=a.dateIso||'',bd=b.dateIso||'';
    if(ad!==bd)return ad<bd?1:-1;
    return (Number(b.id)||0)-(Number(a.id)||0);
  });
}

function summarizeProduction(reports,projects,period='This week',now=new Date()){
  const month=period==='This month';
  const start=month?new Date(now.getFullYear(),now.getMonth(),1):new Date(now.getFullYear(),now.getMonth(),now.getDate()-((now.getDay()+6)%7));
  const labels=month?['W1','W2','W3','W4','W5']:['MON','TUE','WED','THU','FRI','SAT','SUN'];
  const groups=labels.map(()=>({earned:0,actual:0}));
  for(const report of (reports||[]).filter(row=>row.status==='Approved'&&row.dateIso)){
    const date=new Date(`${report.dateIso}T12:00:00`);
    if(date<start||date>now)continue;
    const group=month?Math.min(4,Math.floor((date.getDate()-1)/7)):(date.getDay()+6)%7;
    if(group<0||group>=groups.length)continue;
    const project=projects?.[report.project],entries=report.productionEntries||[],reportLabor=(report.laborEntries||[]).reduce((sum,row)=>sum+Number(row.hours||0),0);
    for(const entry of entries){
      const item=(project?.estimateItems||[]).find(row=>row.id===entry.estimateItemId);
      const rate=item&&Number(item.plannedQuantity)>0?Number(item.budgetHours||0)/Number(item.plannedQuantity):0;
      groups[group].earned+=Number(entry.quantity||0)*rate;
      groups[group].actual+=Number(entry.laborHours||0)||(entries.length===1?reportLabor:0);
    }
  }
  const earned=groups.reduce((sum,row)=>sum+row.earned,0),actual=groups.reduce((sum,row)=>sum+row.actual,0);
  return {labels,groups,earned,actual,efficiency:actual>0&&earned>0?earned/actual*100:null};
}

function projectEfficiency(project,reports,projects){
  const index=(projects||[]).indexOf(project);
  let earned=0,actual=0;
  for(const report of reports||[]){
    if(report.status!=='Approved'||report.project!==index)continue;
    const entries=report.productionEntries||[],reportLabor=(report.laborEntries||[]).reduce((sum,row)=>sum+Number(row.hours||0),0);
    for(const entry of entries){
      const item=(project?.estimateItems||[]).find(row=>row.id===entry.estimateItemId);
      const rate=item&&Number(item.plannedQuantity)>0?Number(item.budgetHours||0)/Number(item.plannedQuantity):0;
      earned+=Number(entry.quantity||0)*rate;
      actual+=Number(entry.laborHours||0)||(entries.length===1?reportLabor:0);
    }
  }
  if(!(actual>0)||!(earned>0))return null;
  return earned/actual*100;
}

function laborRunsAhead(laborPercent,quantityPercent){
  const labor=Number(laborPercent),quantity=Number(quantityPercent);
  return Number.isFinite(labor)&&Number.isFinite(quantity)&&labor>quantity+0.05;
}

function csvRound(value,kind){
  if(value===''||value==null)return '';
  const number=Number(value);
  if(!Number.isFinite(number))return '';
  if(kind==='percent')return number.toFixed(1);
  if(kind==='money')return number.toFixed(2);
  return String(Number(number.toFixed(2)));
}

if(typeof module!=='undefined'&&module.exports){
  module.exports={reportWorkDate,reportSubmittedOn,reportsByWorkDate,summarizeProduction,projectEfficiency,laborRunsAhead,csvRound};
}
