/** ProTanki CreateBattleFormView: native controls, two modifier columns; our admin bots remain available. */
import {BATTLE_MODE,type BattleCreateLimits,type LobbyMap,type NewBattle} from '../../net/lobby.ts';
import {MAX_BOTS,type BattleRules} from '../../net2/protocol.ts';
import {BigButton,DefaultButton,INNER,NumStepper,RES,TankWindow,UI,WindowInner,el,label,place} from './widgets.ts';
import './battle-create.css';
import {ProTankiDropDown} from './ProTankiDropDown.ts';
const SKIN='/battle/battle_create';
const MODES=[[BATTLE_MODE.DM,'dm','DM'],[BATTLE_MODE.TDM,'tdm','TDM'],[BATTLE_MODE.CTF,'ctf','CTF']] as const;
type OptionKey=Exclude<keyof BattleRules,'equipmentConstraintsMode'>;
interface Option {key:OptionKey|string;caption:string;icon?:string;checked:boolean;invert?:boolean;unsupported?:string;team?:boolean;node?:HTMLButtonElement;mark?:HTMLImageElement;state?:HTMLImageElement}
export interface BattleCreateCallbacks {onCreate(battle:NewBattle):void;onCancel():void}
export class BattleCreateView {
 readonly window:TankWindow;
 private readonly dropDowns:ProTankiDropDown[]=[];
 private readonly viewport:HTMLDivElement;
 private readonly body:HTMLDivElement;
 private mapChoices:LobbyMap[]=[];
 private readonly mapSelect:HTMLSelectElement;
 private readonly themeSelect:HTMLSelectElement;
 private readonly formatSelect:HTMLSelectElement;
 private readonly preview:HTMLDivElement;
 private readonly previewFrame:WindowInner;
 private readonly previewImage:HTMLImageElement;
 private readonly mapTitle:HTMLDivElement;
 private readonly rankLabel:HTMLDivElement;
 private readonly rankMin:HTMLInputElement;
 private readonly rankMax:HTMLInputElement;
 private readonly rankBar:HTMLDivElement;
 private readonly rankFill:HTMLDivElement;
 private readonly rankIcons:HTMLImageElement[]=[];
 private readonly modeButtons:{mode:number;button:BigButton}[]=[];
 private readonly fieldLabels:HTMLDivElement[]=[];
 private readonly advancedButton:DefaultButton;
 private advanced=false;
 private readonly people:NumStepper;
 private readonly minutes:NumStepper;
 private readonly kills:NumStepper;
 private readonly bots:NumStepper;
 private readonly captions:HTMLDivElement[]=[];
 private readonly botCaption:HTMLDivElement;
 private readonly nameField:HTMLDivElement;
 private readonly nameInput:HTMLInputElement;
 private readonly createButton:HTMLButtonElement;
 private readonly cancelButton:DefaultButton;
 private readonly options:Option[]=[
  {key:'autoBalance',caption:'Автобаланс',icon:'autoBalance',checked:true,team:true},
  {key:'friendlyFire',caption:'Огонь по своим',icon:'friendlyFire',checked:false,team:true},
  {key:'withoutSupplies',caption:'Припасы',icon:'supplies',checked:true,invert:true},
  {key:'withoutBonuses',caption:'Бонусы',icon:'bonuses',checked:true,invert:true},
  {key:'withoutMines',icon:'supplies',caption:'Мины',checked:true,invert:true},
  {key:'withoutMedkit',icon:'supplies',caption:'Аптечки',checked:true,invert:true},
  {key:'withoutGoldBoxes',caption:'Золотые ящики',icon:'goldBonuses',checked:true,invert:true},
  {key:'withoutCrystals',icon:'bonuses',caption:'Ящики кристаллов',checked:true,invert:true},
  {key:'withoutGoldSiren',icon:'goldBonuses',caption:'Сирена золота',checked:true,invert:true},
  {key:'privateBattle',caption:'Приватная битва',icon:'private',checked:false},
  {key:'withoutUpgrades',caption:'Микроулучшения',icon:'upgrades',checked:true,invert:true},
  {key:'reArmorEnabled',caption:'Смена снаряжения',icon:'rearmor',checked:false,unsupported:'Смена снаряжения во время боя пока не перенесена'},
  {key:'esportDropTiming',icon:'bonuses',caption:'Точные тайминги',checked:false,unsupported:'Тайминги выпадения ProTanki пока не перенесены'},
  {key:'reducedResistances',icon:'bonuses',caption:'Слабые резисты',checked:false,unsupported:'Нет подтверждённых параметров ослабления резистов'},
  {key:'goldZone',icon:'goldBonuses',caption:'Зона золота',checked:false,unsupported:'Отображение зоны выпадения золота пока не перенесено'},
  {key:'randomGold',icon:'goldBonuses',caption:'Случайный фонд',checked:false,unsupported:'Оригинальный расчёт случайного фонда пока не перенесён'},
  {key:'dependentCooldownEnabled',caption:'Общая перезарядка',icon:'dependentCooldowns',checked:false,unsupported:'Общая перезарядка припасов пока не перенесена'},
  {key:'clanBattle',caption:'Клановая битва',icon:'clanVsClan',checked:false,unsupported:'В проекте пока нет кланов'},
  {key:'ultimatesEnabled',caption:'Овердрайвы',icon:'ultimates',checked:false,unsupported:'Овердрайвы пока не перенесены'},
 ];
 private allMaps:LobbyMap[]=[];
 private maps:LobbyMap[]=[];
 private selected:LobbyMap|null=null;
 private limits:BattleCreateLimits|null=null;
 private userRank=1;
 private mode:number=BATTLE_MODE.DM;
 private customName=false;
 private botsEnabled=false;
 private width=300;
 private height=600;
 constructor(parent:HTMLElement,private readonly callbacks:BattleCreateCallbacks){
  this.window=new TankWindow(parent,8);
  this.viewport=el('div','bc-viewport',this.window.root);
  this.body=el('div','bc-body',this.viewport);
  this.mapSelect=this.select('Карта');this.themeSelect=this.select('Тема карты');
  this.mapSelect.onchange=()=>this.selectMap(this.mapChoices[Number(this.mapSelect.value)]??null);
  this.themeSelect.onchange=()=>this.selectMap(this.maps.find(map=>map.mapId===+this.themeSelect.value)??null);
  this.previewFrame=new WindowInner(this.body,INNER.TRANSPARENT);
  this.preview=el('div','lb-abs bc-preview',this.body);
  this.previewImage=el('img','lb-abs',this.preview);this.previewImage.draggable=false;
  this.mapTitle=label(this.preview,'');this.mapTitle.classList.add('bc-map-title');place(this.mapTitle,10,8);
  this.rankLabel=label(this.body,'Звания');
  this.rankBar=el('div','lb-abs bc-rank-bar',this.body);this.rankFill=el('div','bc-rank-fill',this.rankBar);
  const slider=(side:'min'|'max')=>{const input=el('input','bc-rank',this.rankBar);input.type='number';input.hidden=true;input.min='1';input.max='30';input.step='1';input.setAttribute('aria-label',side==='min'?'Минимальное звание':'Максимальное звание');input.oninput=()=>this.changeRank(side);return input;};
  this.rankMin=slider('min');this.rankMax=slider('max');
  for(const side of ['min','max'] as const){
   const handle=el('button','bc-rank-edge bc-rank-edge-'+side,this.rankFill);handle.type='button';handle.setAttribute('role','slider');handle.setAttribute('aria-label',side==='min'?'Минимальное звание':'Максимальное звание');
   handle.onpointerdown=event=>{
    event.preventDefault();event.stopPropagation();const startX=event.clientX,min=+this.rankMin.value,max=+this.rankMax.value;handle.setPointerCapture(event.pointerId);
    handle.onpointermove=move=>{if(move.pointerId!==event.pointerId)return;const delta=Math.round((move.clientX-startX)/Math.max(1,this.rankBar.clientWidth-36)*(+this.rankMin.max-+this.rankMin.min));this.rankMin.value=String(min+(side==='min'?delta:0));this.rankMax.value=String(max+(side==='max'?delta:0));this.changeRank(side);};
    const stop=()=>{handle.onpointermove=null;handle.onpointerup=null;handle.onpointercancel=null;handle.onlostpointercapture=null;};handle.onpointerup=stop;handle.onpointercancel=stop;handle.onlostpointercapture=stop;
   };
   handle.onkeydown=event=>{if(!['ArrowLeft','ArrowRight','ArrowDown','ArrowUp','Home','End'].includes(event.key))return;event.preventDefault();event.stopPropagation();const input=side==='min'?this.rankMin:this.rankMax;input.value=String(event.key==='Home'?+input.min:event.key==='End'?+input.max:+input.value+(['ArrowLeft','ArrowDown'].includes(event.key)?-1:1));this.changeRank(side);};
  }

  this.rankFill.onpointerdown=event=>{
   if((event.target as HTMLElement).closest('.bc-rank-edge'))return;event.preventDefault();const x=event.clientX,min=+this.rankMin.value,max=+this.rankMax.value,span=max-min,low=+this.rankMin.min,high=+this.rankMin.max;
   this.rankFill.setPointerCapture(event.pointerId);
   this.rankFill.onpointermove=move=>{if(move.pointerId!==event.pointerId)return;const shift=Math.round((move.clientX-x)/Math.max(1,this.rankBar.clientWidth-36)*(high-low));const next=Math.max(low,this.userRank-span,Math.min(high-span,this.userRank,min+shift));this.rankMin.value=String(next);this.rankMax.value=String(next+span);this.drawRanks();};
   const stop=()=>{this.rankFill.onpointermove=null;this.rankFill.onpointerup=null;this.rankFill.onpointercancel=null;};this.rankFill.onpointerup=stop;this.rankFill.onpointercancel=stop;
  };
  for(let i=0;i<2;i++){const icon=el('img','bc-rank-icon',this.rankBar);icon.draggable=false;this.rankIcons.push(icon);}
  for(const [mode,name]of [[BATTLE_MODE.DM,'Каждый\nсам за себя'],[BATTLE_MODE.TDM,'Командный\nбой'],[BATTLE_MODE.CTF,'Захват\nфлага'],[3,'Контроль\nточек']] as const){
   const button=new BigButton(this.body,name);button.root.classList.add('bc-type');button.onClick=()=>this.setMode(mode);
   if(mode===3){button.setEnabled(false);button.root.title='Режим контрольных точек пока не перенесён';}
   this.modeButtons.push({mode,button});
  }
  this.formatSelect=this.select('Формат битвы');
  for(const [value,name]of [['NONE','Обычный'],['HORNET_RAILGUN','ХР: Хорнет / Рельса'],['WASP_RAILGUN','ВР: Васп / Рельса'],['HORNET_WASP_RAILGUN','ХВР: Хорнет, Васп / Рельса']])this.formatSelect.add(new Option(name,value));
  for(const name of ['Паркур','Лёгкий формат','Тяжёлый формат']){const option=new Option(name+' — недоступно');option.disabled=true;this.formatSelect.add(option);}
  this.formatSelect.onchange=()=>this.updateBotRange();
  const stepper=(caption:string)=>{this.captions.push(label(this.body,caption));return new NumStepper(this.body);};
  this.people=stepper('Игроков');this.minutes=stepper('Минут');this.kills=stepper('Убийств');
  this.people.onChange=()=>this.updateBotRange();this.minutes.setRange(0,999);this.kills.setRange(0,9999);
  this.botCaption=label(this.body,'Боты: Васп М3 / пушки М0');this.bots=new NumStepper(this.body);this.bots.setRange(0,MAX_BOTS);this.bots.value=0;
  for(const option of this.options)this.addOption(option);
  this.nameField=el('div','lb-input',this.body);
  for(const part of ['InputLeft','InputCenter','InputRight'])el('div','',this.nameField).style.backgroundImage=`url(${UI()}/${part}.png)`;
  (this.nameField.children[0]as HTMLElement).style.width=(this.nameField.children[2]as HTMLElement).style.width='5px';
  this.nameInput=el('input','lb-stepper-input bc-name',this.nameField);this.nameInput.maxLength=30;this.nameInput.placeholder='Название битвы';
  this.nameInput.oninput=()=>{this.customName=!!this.nameInput.value.trim();this.updateButton();};
  this.nameInput.onkeydown=e=>e.stopPropagation();
  this.createButton=el('button','lb-abs bc-create-button',this.window.root);this.createButton.type='button';this.createButton.textContent='Запустить';this.createButton.onclick=()=>this.create();
  for(const caption of ['Название:','Карта:','Тема:'])this.fieldLabels.push(label(this.body,caption));
  this.advancedButton=new DefaultButton(this.body,'Дополнительные параметры ▾');this.advancedButton.onClick=()=>{this.advanced=!this.advanced;this.advancedButton.caption='Дополнительные параметры '+(this.advanced?'▴':'▾');this.layout();};
  this.rankLabel.hidden=true;this.mapTitle.hidden=true;
  const caption=this.window.root.querySelector('.lb-window-caption');if(caption)caption.textContent='Создание битвы';
  this.cancelButton=new DefaultButton(this.window.root,'Отмена');this.cancelButton.onClick=()=>callbacks.onCancel();
 }
 private select(caption:string):HTMLSelectElement{const frame=el('div','lb-abs bc-select-frame',this.body);const select=el('select','bc-select',frame);select.setAttribute('aria-label',caption);select.title=caption;select.onkeydown=e=>e.stopPropagation();this.dropDowns.push(new ProTankiDropDown(select));return select;}
 private addOption(option:Option):void{
  const node=option.node=el('button','lb-abs bc-option',this.body);node.type='button';node.setAttribute('role','checkbox');node.disabled=!!option.unsupported;
  node.title=option.unsupported??option.caption;
  const state=option.state=el('img','lb-abs',node);state.src=`${SKIN}/CheckBoxBase_checkboxUpClass.png`;
  const mark=option.mark=el('img','lb-abs',node);mark.src=`${SKIN}/${option.icon?'BattleParamsCheckButtonIcons_'+option.icon+'Class':'CheckBoxBase_defaultCheckedClass'}.png`;
  const text=label(node,option.caption);place(text,29,7);text.style.fontSize='12px';
  node.onclick=()=>{option.checked=!option.checked;this.drawOption(option);this.layout();};
  node.onpointerenter=()=>{state.src=`${SKIN}/CheckBoxBase_checkboxOverClass.png`;};
  node.onpointerleave=()=>{state.src=`${SKIN}/CheckBoxBase_checkboxUpClass.png`;};
  node.onpointerdown=()=>{state.src=`${SKIN}/CheckBoxBase_checkboxDownClass.png`;};
  node.onpointerup=()=>{state.src=`${SKIN}/CheckBoxBase_checkboxOverClass.png`;};
  this.drawOption(option);
 }
 private drawOption(option:Option):void{option.mark!.hidden=!option.checked;option.node!.setAttribute('aria-checked',String(option.checked));}
 set visible(value:boolean){this.window.root.style.visibility=value?'':'hidden';if(!value)this.closeMenus();}
 closeMenus():void{for(const menu of this.dropDowns)menu.close();}
 setBotsEnabled(value:boolean):void{this.botsEnabled=value;if(!value)this.bots.value=0;this.layout();}
 setUserRank(rank:number):void{this.userRank=rank;this.resetRanks();}
 reset(maps:LobbyMap[],limits:BattleCreateLimits|null):void{
  this.allMaps=maps;this.limits=limits;this.customName=false;this.nameInput.value='';this.bots.value=0;this.formatSelect.value='NONE';
  for(const option of this.options){option.checked=!option.unsupported&&option.key!=='friendlyFire'&&option.key!=='privateBattle';this.drawOption(option);}
  this.viewport.scrollTop=0;this.setMode(this.mode);
 }
 private setMode(mode:number):void{
  this.mode=mode;for(const entry of this.modeButtons){entry.button.root.classList.toggle('bc-type-selected',entry.mode===mode);entry.button.root.setAttribute('aria-pressed',String(entry.mode===mode));}
  for(const option of this.options)if(option.team){option.node!.disabled=mode===BATTLE_MODE.DM;option.node!.title=mode===BATTLE_MODE.DM?'Только для командного боя':option.caption;}
  this.captions[2].textContent=mode===BATTLE_MODE.CTF?'Флагов':mode===BATTLE_MODE.TDM?'Очков':'Убийств';
  const defaults=this.limits?.limits[mode];this.minutes.value=defaults?Math.round(defaults.timeLimit/60):15;this.kills.value=defaults?.scoreLimit??0;
  this.maps=this.allMaps.filter(map=>!map.modes.length||map.modes.includes(mode));this.mapSelect.replaceChildren();
  const choices=new Map<string,LobbyMap>();
  for(const map of this.maps){
   const current=choices.get(map.name);
   if(!current||(!this.accessible(current)&&this.accessible(map)))choices.set(map.name,map);
  }
  this.mapChoices=[...choices.values()];
  this.mapChoices.forEach((map,index)=>{const option=new Option(map.name,String(index));option.disabled=!this.accessible(map);this.mapSelect.add(option);});
  this.selectMap(this.maps.find(map=>map.mapId===this.selected?.mapId)??this.maps.find(map=>this.accessible(map))??null);
 }
 private accessible(map:LobbyMap):boolean{return this.userRank>=map.rankMin&&this.userRank<=map.rankMax;}
 private selectMap(map:LobbyMap|null):void{
  this.selected=map;this.mapSelect.value=String(this.mapChoices.findIndex(choice=>choice.name===map?.name));this.mapTitle.textContent=map?.name??'Нет доступных карт';
  this.previewImage.hidden=!map;if(map)this.previewImage.src=`${RES}/${map.previewId}.png`;
  this.themeSelect.replaceChildren();
  const variants=this.maps.filter(candidate=>candidate.name===map?.name);
  for(const variant of variants){
   const label=['Лето','Зима','Космос','Лето, ночь','Зима, ночь','Лето Old'][variant.theme]??'Тема карты';
   const option=new Option(label,String(variant.mapId));
   option.disabled=!this.accessible(variant);this.themeSelect.add(option);
  }
  this.themeSelect.value=String(map?.mapId);
  this.themeSelect.disabled=variants.filter(variant=>this.accessible(variant)).length<2;
  this.themeSelect.title=this.themeSelect.disabled?'Доступна только установленная тема карты':'Тема карты';
  if(map){this.people.setRange(2,map.maxPeople);this.people.value=map.maxPeople;if(!this.customName)this.nameInput.value=`${map.name} ${MODES.find(m=>m[0]===this.mode)?.[2]??'DM'}`.slice(0,30);}
  this.resetRanks();this.updateBotRange();this.layout();
 }
 private resetRanks():void{
  const low=Math.max(1,this.selected?.rankMin??1),high=Math.min(30,this.selected?.rankMax||30),length=this.limits?.maxRangeLength??5;
  const min=Math.max(low,Math.min(this.userRank-Math.floor((length-1)/2),high-length+1));
  for(const input of [this.rankMin,this.rankMax]){input.min=String(low);input.max=String(high);}
  this.rankMin.value=String(min);this.rankMax.value=String(Math.min(high,min+length-1));this.drawRanks();
 }
 private changeRank(side:'min'|'max'):void{
  let min=Math.max(+this.rankMin.min,Math.min(+this.rankMin.max,+this.rankMin.value)),max=Math.max(+this.rankMax.min,Math.min(+this.rankMax.max,+this.rankMax.value));const span=Math.max(0,(this.limits?.maxRangeLength??5)-1);
  min=Math.min(min,this.userRank);max=Math.max(max,this.userRank);
  if(side==='min'){if(max-min>span)max=min+span;if(max<this.userRank){max=this.userRank;min=Math.max(+this.rankMin.min,max-span);}}
  else{if(max-min>span)min=max-span;if(min>this.userRank){min=this.userRank;max=Math.min(+this.rankMax.max,min+span);}}
  this.rankMin.value=String(min);this.rankMax.value=String(max);this.drawRanks();
 }
 private drawRanks():void{
  this.rankLabel.textContent=`Звания: ${this.rankMin.value} — ${this.rankMax.value}`;this.rankBar.title=this.rankLabel.textContent;this.rankFill.dataset.single=String(this.rankMin.value===this.rankMax.value);
  this.rankFill.querySelectorAll<HTMLButtonElement>('.bc-rank-edge').forEach((handle,index)=>{handle.setAttribute('aria-valuemin',this.rankMin.min);handle.setAttribute('aria-valuemax',this.rankMin.max);handle.setAttribute('aria-valuenow',index?this.rankMax.value:this.rankMin.value);});
  this.rankIcons.forEach((icon,index)=>{icon.src=`${UI()}/RangIconSmall/${index?this.rankMax.value:this.rankMin.value}.png`;icon.hidden=index===1&&this.rankMin.value===this.rankMax.value;});
  const low=+this.rankMin.min,span=Math.max(1,+this.rankMin.max-low);const left=(+this.rankMin.value-low)/span,right=(+this.rankMax.value-low)/span;this.rankFill.style.left=`calc(${left*100}% - ${left*36}px)`;this.rankFill.style.width=`calc(${(right-left)*100}% + ${36-(right-left)*36}px)`;this.rankIcons.forEach((icon,index)=>{const ratio=index?right:left;icon.style.left=`calc(${ratio*100}% + ${(index?14:this.rankMin.value===this.rankMax.value?12:11)-ratio*36}px)`;});this.updateButton();
 }
 private updateBotRange():void{
  const incompatible=this.formatSelect.value==='HORNET_RAILGUN',slots=this.mode===BATTLE_MODE.DM?this.people.value:Math.floor(this.people.value/2)*2;
  this.bots.setRange(0,incompatible?0:Math.min(MAX_BOTS,slots-1));this.bots.setEnabled(!incompatible);this.bots.root.title=incompatible?'Боты используют Васп и не подходят для формата ХР':'';
 }
 private updateButton():void{if(this.createButton)this.createButton.disabled=!(this.selected&&this.accessible(this.selected)&&!this.limits?.disabled&&this.nameInput?.value.trim());}
 private create():void{
  const map=this.selected;if(!map||!this.accessible(map)||this.limits?.disabled||!this.nameInput.value.trim())return;
  const rules:BattleRules={equipmentConstraintsMode:this.formatSelect.value as BattleRules['equipmentConstraintsMode']};
  for(const option of this.options)if(!option.unsupported)(rules as Record<string,unknown>)[option.key]=option.team&&this.mode===BATTLE_MODE.DM?false:option.invert?!option.checked:option.checked;
  this.callbacks.onCreate({...rules,name:this.nameInput.value.trim().slice(0,30),mode:this.mode,mapId:map.mapId,theme:map.theme,maxPeople:this.people.value,botCount:this.botsEnabled?this.bots.value:0,scoreLimit:this.kills.value,timeLimit:this.minutes.value*60,rankMin:+this.rankMin.value,rankMax:+this.rankMax.value,withoutBonuses:rules.withoutBonuses??false,withoutCrystals:rules.withoutCrystals??false,withoutSupplies:rules.withoutSupplies??false,autoBalance:rules.autoBalance??false,friendlyFire:rules.friendlyFire??false});
 }
 setBounds(x:number,y:number,width:number,height:number):void{this.width=width;this.height=height;this.window.setBounds(x,y,width,height);this.layout();}
 private layout():void{
  const width=this.width-22,contentWidth=width-8,col=Math.floor((contentWidth-8)/2);
  const enabled=(key:string)=>this.options.find(o=>o.key===key)?.checked??false;
  const columns=[['withoutBonuses','withoutSupplies',...(enabled('withoutSupplies')?['withoutMines','withoutMedkit']:[]),'autoBalance'],['withoutCrystals','withoutUpgrades','withoutGoldBoxes',...(enabled('withoutGoldBoxes')?['withoutGoldSiren']:[]),'friendlyFire']];
  const rows=Math.max(...columns.map(column=>column.length)),advancedRows=this.advanced?Math.ceil(this.options.filter(o=>o.unsupported).length/2):0;
  const contentHeight=this.height-72;
  const fixedHeight=72+5+36+57+54+36+(this.botsEnabled?36:0)+rows*34+36+(advancedRows?advancedRows*34+6:0);
  const previewHeight=Math.max(100,contentHeight-fixedHeight);
  place(this.viewport,11,11,width,contentHeight);this.body.style.width=contentWidth+'px';
  place(this.fieldLabels[0],2,7);place(this.nameField,62,0,contentWidth-62,30);
  place(this.fieldLabels[1],2,43);place(this.mapSelect.parentElement!,40,36,col-40,30);place(this.fieldLabels[2],col+10,43);place(this.themeSelect.parentElement!,col+48,36,col-40,30);
  this.previewFrame.setBounds(0,72,contentWidth,previewHeight);place(this.preview,1,73,contentWidth-2,previewHeight-2);
  // Scale the complete map preview to the frame, as BattleInfoParamsView.
  this.previewImage.style.objectFit='cover';place(this.previewImage,0,0,contentWidth-2,previewHeight-2);
  let top=72+previewHeight+5;place(this.rankBar,0,top,contentWidth,30);this.rankBar.title=this.rankLabel.textContent??'Звания';top+=36;
  const fourth=(contentWidth-15)/4;this.modeButtons.forEach((entry,index)=>entry.button.setBounds(index*(fourth+5),top,fourth));top+=57;
  const third=Math.floor(contentWidth/3);[this.people,this.minutes,this.kills].forEach((stepper,index)=>{const x=third*index+Math.max(0,(third-76)/2);place(this.captions[index],third*index,top,third);this.captions[index].style.textAlign='center';place(stepper.root,x-19,top+19);stepper.root.title=index===0?'Всего игроков':'0 — без лимита';});top+=54;
  place(this.formatSelect.parentElement!,col+8,top,col,30);const privateOption=this.options.find(o=>o.key==='privateBattle')!;place(privateOption.node!,0,top,col,30);privateOption.node!.hidden=false;top+=36;
  this.botCaption.hidden=this.bots.root.hidden=!this.botsEnabled;
  if(this.botsEnabled){place(this.botCaption,2,top+7);place(this.bots.root,contentWidth-95,top);top+=36;}
  for(const option of this.options)if(option.key!=='privateBattle')option.node!.hidden=true;
  columns.forEach((column,index)=>column.forEach((key,row)=>{const option=this.options.find(o=>o.key===key)!;const indent=['withoutMines','withoutMedkit','withoutGoldSiren'].includes(key)?20:0;option.node!.hidden=false;place(option.node!,index*(col+8)+indent,top+row*34,col-indent,30);}));top+=rows*34;
  this.advancedButton.setBounds(0,top,contentWidth);top+=36;
  if(this.advanced){const advanced=this.options.filter(o=>o.unsupported);advanced.forEach((option,index)=>{option.node!.hidden=false;place(option.node!,index%2*(col+8),top+Math.floor(index/2)*34,col,30);});top+=Math.ceil(advanced.length/2)*34+6;}
  for(const menu of this.dropDowns)menu.sync();
  this.body.style.height=top+'px';this.cancelButton.setBounds(11,this.height-41,90);place(this.createButton,this.width-141,this.height-41,130,30);
 }
}
