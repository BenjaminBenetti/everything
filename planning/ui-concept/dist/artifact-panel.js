/* A non-modal split: resizing the artifact gives real layout space back to the chat. */
const workspace = document.getElementById('workspace');
const artifactPane = document.getElementById('artifact-panel');
const artifactDivider = document.getElementById('artifact-divider');
const artifactStacked = matchMedia('(max-width:850px)');
const artifactSizes = {wide:.52,stacked:.45};
let artifactMotion, artifactTrigger, artifactDrag;
try{const saved=JSON.parse(localStorage.getItem('everything-artifact-split-v1'));for(const key of ['wide','stacked'])if(Number.isFinite(saved?.[key]))artifactSizes[key]=Math.min(.75,Math.max(.25,saved[key]))}catch{}
function artifactUrl(){return `artifact.html?theme=${encodeURIComponent(EverythingTheme.current())}`}
function syncArtifactTheme(){
 const link=artifactPane.querySelector('[data-artifact-tab]');if(link)link.href=artifactUrl();
 artifactPane.querySelector('iframe')?.contentWindow.postMessage({type:'theme',theme:EverythingTheme.current()},location.origin);
}
function artifactGeometry(){
 const stacked=artifactStacked.matches,rect=workspace.getBoundingClientRect();
 const sidebar=stacked?0:root.querySelector('.sidebar')?.getBoundingClientRect().width||0;
 const available=(stacked?rect.height:rect.width-sidebar)-1;
 const min=stacked?Math.min(220,available*.4):320;
 const max=stacked?available-Math.min(300,available*.5):available-320;
 return {stacked,rect,available,min,max:Math.max(min,max),key:stacked?'stacked':'wide'};
}
function setArtifactSize(ratio){
 const messages=root.querySelector('.messages');
 const atBottom=messages&&messages.scrollHeight-messages.clientHeight-messages.scrollTop<32;
 const g=artifactGeometry();
 const size=Math.min(g.max,Math.max(g.min,(ratio??artifactSizes[g.key])*g.available));
 workspace.style.setProperty('--artifact-size',`${size}px`);
 artifactDivider.setAttribute('aria-orientation',g.stacked?'horizontal':'vertical');
 artifactDivider.setAttribute('aria-valuemin',Math.round(g.min/g.available*100));
 artifactDivider.setAttribute('aria-valuemax',Math.round(g.max/g.available*100));
 artifactDivider.setAttribute('aria-valuenow',Math.round(size/g.available*100));
 artifactDivider.setAttribute('aria-valuetext',`Artifact uses ${Math.round(size/g.available*100)} percent`);
 if(ratio!==undefined)artifactSizes[g.key]=size/g.available;
 if(atBottom)requestAnimationFrame(()=>{if(messages.isConnected)messages.scrollTop=messages.scrollHeight});
 return size;
}
function saveArtifactSize(){try{localStorage.setItem('everything-artifact-split-v1',JSON.stringify(artifactSizes))}catch{}}
function artifact(){
 if(!artifactPane.hidden)return;
 artifactTrigger=document.activeElement;
 const messages=root.querySelector('.messages');
 const atBottom=messages&&messages.scrollHeight-messages.clientHeight-messages.scrollTop<32;
 dialog.close();
 // Shared-work details and the artifact use the same side of the conversation.
 panel=false;renderedPanel=false;root.querySelector('.sidepanel')?.remove();root.querySelector('[data-panel]')?.setAttribute('aria-expanded','false');
 const url=artifactUrl();
 artifactPane.innerHTML=`<header class="artifact-panel-head"><div class="artifact-panel-title"><div class="eyebrow">Shared artifact</div><h2 id="artifact-title">A first direction</h2></div><a class="button light artifact-open-tab" data-artifact-tab href="${url}" target="_blank" rel="noopener">Open in new tab ${icon('external')}</a><button class="icon-button" data-artifact-close aria-label="Close artifact">${icon('close')}</button></header><iframe class="artifact-frame" src="${url}" title="Everything · A first direction"></iframe>`;
 artifactPane.querySelector('[data-artifact-close]').addEventListener('click',()=>closeArtifact());
 artifactPane.querySelector('iframe').addEventListener('load',syncArtifactTheme);
 artifactPane.hidden=false;artifactDivider.hidden=false;workspace.classList.add('has-artifact');
 const size=setArtifactSize();
 if(!matchMedia('(prefers-reduced-motion: reduce)').matches){
  const observer=atBottom?new ResizeObserver(()=>{messages.scrollTop=messages.scrollHeight}):null;
  observer?.observe(messages);
  artifactMotion=artifactPane.animate([{flexBasis:'0px'},{flexBasis:`${size}px`}],{duration:340,easing:'cubic-bezier(.22,1,.36,1)'});
  artifactMotion.finished.finally(()=>observer?.disconnect()).catch(()=>{});
 }
}
function closeArtifact(immediate=false){
 if(artifactPane.hidden)return;
 const restoreFocus=artifactPane.contains(document.activeElement)||document.activeElement===artifactDivider;
 const g=artifactGeometry(),current=artifactPane.getBoundingClientRect()[g.stacked?'height':'width'];
 artifactMotion?.cancel();endArtifactDrag();
 const finish=()=>{
  artifactMotion?.cancel();artifactMotion=null;
  artifactPane.hidden=true;artifactDivider.hidden=true;workspace.classList.remove('has-artifact');artifactPane.replaceChildren();
  if(restoreFocus&&!immediate)(artifactTrigger?.isConnected?artifactTrigger:root.querySelector('#message-input, [data-artifact]'))?.focus({preventScroll:true});
 };
 if(immediate||matchMedia('(prefers-reduced-motion: reduce)').matches){finish();return;}
 const animation=artifactPane.animate([{flexBasis:`${current}px`},{flexBasis:'0px'}],{duration:240,easing:'cubic-bezier(.4,0,1,1)',fill:'both'});
 artifactMotion=animation;
 animation.finished.then(()=>{if(artifactMotion===animation)finish()}).catch(()=>{});
}
function endArtifactDrag(){
 if(artifactDrag!==undefined&&artifactDivider.hasPointerCapture(artifactDrag))artifactDivider.releasePointerCapture(artifactDrag);
 artifactDrag=undefined;workspace.classList.remove('is-resizing');saveArtifactSize();
}
artifactDivider.addEventListener('pointerdown',e=>{
 if(!e.isPrimary||e.button!==0)return;
 artifactMotion?.cancel();artifactDrag=e.pointerId;artifactDivider.setPointerCapture(e.pointerId);artifactDivider.focus();workspace.classList.add('is-resizing');e.preventDefault();
});
artifactDivider.addEventListener('pointermove',e=>{
 if(e.pointerId!==artifactDrag)return;
 const g=artifactGeometry();setArtifactSize((g.stacked?g.rect.bottom-e.clientY:g.rect.right-e.clientX)/g.available);
});
for(const type of ['pointerup','pointercancel','lostpointercapture'])artifactDivider.addEventListener(type,endArtifactDrag);
artifactDivider.addEventListener('keydown',e=>{
 const g=artifactGeometry(),positive=g.stacked?'ArrowUp':'ArrowLeft',negative=g.stacked?'ArrowDown':'ArrowRight';
 if(![positive,negative,'Home','End','Enter'].includes(e.key))return;
 e.preventDefault();artifactMotion?.cancel();
 const ratio=e.key==='Home'?g.min/g.available:e.key==='End'?g.max/g.available:e.key==='Enter'?(g.stacked ? .45 : .52):Number(artifactDivider.getAttribute('aria-valuenow'))/100+(e.key===positive ? .04 : -.04);
 setArtifactSize(ratio);saveArtifactSize();
});
artifactDivider.addEventListener('dblclick',()=>{setArtifactSize(artifactStacked.matches ? .45 : .52);saveArtifactSize()});
window.addEventListener('resize',()=>{if(!artifactPane.hidden){artifactMotion?.cancel();setArtifactSize()}});
window.addEventListener('themechange',syncArtifactTheme);
window.addEventListener('keydown',e=>{if(e.key==='Escape'&&!e.isComposing&&!dialog.open&&!artifactPane.hidden){e.preventDefault();closeArtifact()}});
window.addEventListener('message',e=>{if(e.origin===location.origin&&e.source===artifactPane.querySelector('iframe')?.contentWindow&&e.data?.type==='close-artifact')closeArtifact()});
