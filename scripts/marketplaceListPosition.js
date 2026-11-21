'use strict';
function position(reset=false){
 const norm=s=>String(s||'').replace(/\s+/g,' ').trim().toLowerCase();
 const grid=[...document.querySelectorAll('[role="grid"][aria-label]')].find(e=>norm(e.getAttribute('aria-label'))==='marketplace'&&e.getBoundingClientRect().width>2);
 if(!grid)return {ok:false,reason:'marketplace_grid_missing'};
 let examined=0,moved=0;
 for(let el=grid;el&&el!==document.body&&el!==document.documentElement&&examined++<12;el=el.parentElement){
  const style=getComputedStyle(el);if(!/(auto|scroll)/.test(style.overflowY)||el.scrollHeight<=el.clientHeight+2)continue;
  if(reset&&el.scrollTop>2){el.scrollTop=0;moved++;}
  if(el.scrollTop>2)return {ok:false,reason:'marketplace_list_not_at_top',scrollTop:el.scrollTop,moved};
 }
 return {ok:true,reason:'top',moved};
}
async function reset(page){const result=await page.evaluate(position,true);if(!result.ok){const error=Error('virtus_marketplace_position_unconfirmed');error.details=result;throw error;}return result;}
module.exports={position,reset};
