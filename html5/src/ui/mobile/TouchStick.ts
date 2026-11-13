/** CSS-pixel dead zones shared by the touch stick and offline input checks. */
export function stickAxes(x:number,y:number,radius=60):{move:number;turn:number}{
 const axis=(value:number,deadZone:number)=>{
  const magnitude=Math.max(0,Math.min(1,(Math.abs(value)/radius-deadZone)/(1-deadZone)));
  return magnitude===0 ? 0 : Math.sign(value)*magnitude;
 };
 return {move:axis(-y,.22),turn:axis(-x,.28)};
}

export function stickKeys(x:number,y:number,radius=60):number[]{
 const keys:number[]=[];
 if(y<-.22*radius)keys.push(87);else if(y>.22*radius)keys.push(83);
 if(x<-.28*radius)keys.push(65);else if(x>.28*radius)keys.push(68);
 return keys;
}
