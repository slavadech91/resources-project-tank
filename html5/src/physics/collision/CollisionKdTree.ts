// 1:1 из alternativa/physics/collision/{CollisionKdNode,CollisionKdTree,CollisionKdTree2D}.as
import { AABB } from './types.ts';
import type { CollisionShape } from './CollisionShape.ts';

export class CollisionKdNode {
  indices: number[] | null = null; // §4!G§
  splitIndices: number[] | null = null; // §6"G§ — объекты, пересекающие плоскость раздела
  boundBox: AABB = null as unknown as AABB; // §;3§
  parent: CollisionKdNode | null = null; // §0"+§
  splitTree: CollisionKdTree2D | null = null; // §1"J§
  axis = -1; // §-m§
  coord = 0; // §6!9§
  positiveNode: CollisionKdNode | null = null; // §2!,§
  negativeNode: CollisionKdNode | null = null; // §0v§
}

/** Общий подбор плоскости раздела (checkNodeAxis у обоих деревьев идентичен). */
class SplitSearch {
  splitAxis = -1; // §1<§
  splitCost = 0; // §,!m§
  splitCoord = 0; // §7A§

  check(
    threshold: number,
    staticBoundBoxes: AABB[],
    node: CollisionKdNode,
    axis: number,
    numSplitCoords: number,
    splitCoords: number[],
    bb: number[],
  ): void {
    const axis1 = (axis + 1) % 3;
    const axis2 = (axis + 2) % 3;
    const area = (bb[axis1 + 3] - bb[axis1]) * (bb[axis2 + 3] - bb[axis2]);
    for (let n = 0; n < numSplitCoords; n++) {
      const currSplitCoord = splitCoords[n];
      if (isNaN(currSplitCoord)) continue;
      const minCoord = currSplitCoord - threshold;
      const maxCoord = currSplitCoord + threshold;
      const areaNegative = area * (currSplitCoord - bb[axis]);
      const areaPositive = area * (bb[axis + 3] - currSplitCoord);
      let numNegative = 0;
      let numPositive = 0;
      let conflict = false;
      const indices = node.indices as number[];
      const numObjects = indices.length;
      for (let m = 0; m < numObjects; m++) {
        const boundBox = staticBoundBoxes[indices[m]];
        objectBB[0] = boundBox.minX;
        objectBB[1] = boundBox.minY;
        objectBB[2] = boundBox.minZ;
        objectBB[3] = boundBox.maxX;
        objectBB[4] = boundBox.maxY;
        objectBB[5] = boundBox.maxZ;
        if (objectBB[axis + 3] <= maxCoord) {
          if (objectBB[axis] < minCoord) numNegative++;
        } else {
          if (objectBB[axis] < minCoord) {
            conflict = true;
            break;
          }
          numPositive++;
        }
      }
      const cost = areaNegative * numNegative + areaPositive * numPositive;
      if (!conflict && cost < this.splitCost && numNegative > 0 && numPositive > 0) {
        this.splitAxis = axis;
        this.splitCost = cost;
        this.splitCoord = currSplitCoord;
      }
      for (let m = n + 1; m < numSplitCoords; m++) {
        if (splitCoords[m] >= currSplitCoord - threshold && splitCoords[m] <= currSplitCoord + threshold) {
          splitCoords[m] = NaN;
        }
      }
    }
  }
}

const boundBox = new AABB(); // §8!;§
const splitCoordsX: number[] = []; // §#"S§
const splitCoordsY: number[] = []; // §3"C§
const splitCoordsZ: number[] = []; // §?!G§
const nodeBB: number[] = [0, 0, 0, 0, 0, 0]; // §%h§
const objectBB: number[] = [0, 0, 0, 0, 0, 0]; // §5"0§

function shrinkBoundBox(source: AABB, threshold: number): void {
  boundBox.minX = source.minX + threshold;
  boundBox.minY = source.minY + threshold;
  boundBox.minZ = source.minZ + threshold;
  boundBox.maxX = source.maxX - threshold;
  boundBox.maxY = source.maxY - threshold;
  boundBox.maxZ = source.maxZ - threshold;
}

function fillNodeBB(source: AABB): void {
  nodeBB[0] = source.minX;
  nodeBB[1] = source.minY;
  nodeBB[2] = source.minZ;
  nodeBB[3] = source.maxX;
  nodeBB[4] = source.maxY;
  nodeBB[5] = source.maxZ;
}

function createChildren(node: CollisionKdNode, nodeBoundBox: AABB, axis: number, coord: number): void {
  node.axis = axis;
  node.coord = coord;
  const negative = new CollisionKdNode();
  negative.parent = node;
  negative.boundBox = nodeBoundBox.clone();
  const positive = new CollisionKdNode();
  positive.parent = node;
  positive.boundBox = nodeBoundBox.clone();
  node.negativeNode = negative;
  node.positiveNode = positive;
  if (axis == 0) {
    negative.boundBox.maxX = positive.boundBox.minX = coord;
  } else if (axis == 1) {
    negative.boundBox.maxY = positive.boundBox.minY = coord;
  } else {
    negative.boundBox.maxZ = positive.boundBox.minZ = coord;
  }
}

/** Удаляет помеченные -1 индексы; если не осталось ни одного — node.indices = null. */
function compactIndices(node: CollisionKdNode, indices: number[], count: number): void {
  let j = 0;
  for (let n = 0; n < count; n++) {
    if (indices[n] >= 0) indices[j++] = indices[n];
  }
  if (j > 0) indices.length = j;
  else node.indices = null;
}

export class CollisionKdTree {
  threshold = 0.1; // §&!@§
  minPrimitivesPerNode = 1; // § !i§
  rootNode: CollisionKdNode = null as unknown as CollisionKdNode; // §#T§
  staticChildren: CollisionShape[] = []; // §#"N§
  numStaticChildren = 0; // §1A§
  staticBoundBoxes: AABB[] = []; // §=!"§
  private readonly search = new SplitSearch();

  createTree(collisionPrimitives: CollisionShape[], rootBoundBox: AABB | null = null): void {
    this.staticChildren = collisionPrimitives.concat();
    this.numStaticChildren = this.staticChildren.length;
    this.rootNode = new CollisionKdNode();
    const indices: number[] = [];
    this.rootNode.indices = indices;
    const rootBB = (this.rootNode.boundBox = rootBoundBox != null ? rootBoundBox : new AABB());
    for (let n = 0; n < this.numStaticChildren; n++) {
      const child = this.staticChildren[n];
      const bb = (this.staticBoundBoxes[n] = child.calculateAABB());
      rootBB.addBoundBox(bb);
      indices[n] = n;
    }
    this.staticBoundBoxes.length = this.numStaticChildren;
    this.splitNode(this.rootNode);
    splitCoordsX.length = splitCoordsY.length = splitCoordsZ.length = 0;
  }

  private splitNode(node: CollisionKdNode): void {
    const indices = node.indices as number[];
    const numObjects = indices.length;
    if (numObjects <= this.minPrimitivesPerNode) return;
    const nodeBoundBox = node.boundBox;
    shrinkBoundBox(nodeBoundBox, this.threshold);
    const doubleThreshold = this.threshold * 2;
    let numX = 0;
    let numY = 0;
    let numZ = 0;
    for (let n = 0; n < numObjects; n++) {
      const bb = this.staticBoundBoxes[indices[n]];
      if (bb.maxX - bb.minX <= doubleThreshold) {
        if (bb.minX <= boundBox.minX) splitCoordsX[numX++] = nodeBoundBox.minX;
        else if (bb.maxX >= boundBox.maxX) splitCoordsX[numX++] = nodeBoundBox.maxX;
        else splitCoordsX[numX++] = (bb.minX + bb.maxX) * 0.5;
      } else {
        if (bb.minX > boundBox.minX) splitCoordsX[numX++] = bb.minX;
        if (bb.maxX < boundBox.maxX) splitCoordsX[numX++] = bb.maxX;
      }
      if (bb.maxY - bb.minY <= doubleThreshold) {
        if (bb.minY <= boundBox.minY) splitCoordsY[numY++] = nodeBoundBox.minY;
        else if (bb.maxY >= boundBox.maxY) splitCoordsY[numY++] = nodeBoundBox.maxY;
        else splitCoordsY[numY++] = (bb.minY + bb.maxY) * 0.5;
      } else {
        if (bb.minY > boundBox.minY) splitCoordsY[numY++] = bb.minY;
        if (bb.maxY < boundBox.maxY) splitCoordsY[numY++] = bb.maxY;
      }
      if (bb.maxZ - bb.minZ <= doubleThreshold) {
        if (bb.minZ <= boundBox.minZ) splitCoordsZ[numZ++] = nodeBoundBox.minZ;
        else if (bb.maxZ >= boundBox.maxZ) splitCoordsZ[numZ++] = nodeBoundBox.maxZ;
        else splitCoordsZ[numZ++] = (bb.minZ + bb.maxZ) * 0.5;
      } else {
        if (bb.minZ > boundBox.minZ) splitCoordsZ[numZ++] = bb.minZ;
        if (bb.maxZ < boundBox.maxZ) splitCoordsZ[numZ++] = bb.maxZ;
      }
    }
    const search = this.search;
    search.splitAxis = -1;
    search.splitCost = 1e308;
    fillNodeBB(nodeBoundBox);
    search.check(this.threshold, this.staticBoundBoxes, node, 0, numX, splitCoordsX, nodeBB);
    search.check(this.threshold, this.staticBoundBoxes, node, 1, numY, splitCoordsY, nodeBB);
    search.check(this.threshold, this.staticBoundBoxes, node, 2, numZ, splitCoordsZ, nodeBB);
    if (search.splitAxis < 0) return;
    const axisX = search.splitAxis == 0;
    const axisY = search.splitAxis == 1;
    const splitCoord = search.splitCoord;
    createChildren(node, nodeBoundBox, search.splitAxis, splitCoord);
    const negative = node.negativeNode as CollisionKdNode;
    const positive = node.positiveNode as CollisionKdNode;
    const coordMin = splitCoord - this.threshold;
    const coordMax = splitCoord + this.threshold;
    for (let n = 0; n < numObjects; n++) {
      const bb = this.staticBoundBoxes[indices[n]];
      const min = axisX ? bb.minX : axisY ? bb.minY : bb.minZ;
      const max = axisX ? bb.maxX : axisY ? bb.maxY : bb.maxZ;
      if (max <= coordMax) {
        if (min < coordMin) {
          if (negative.indices == null) negative.indices = [];
          negative.indices.push(indices[n]);
          indices[n] = -1;
        } else {
          if (node.splitIndices == null) node.splitIndices = [];
          node.splitIndices.push(indices[n]);
          indices[n] = -1;
        }
      } else if (min >= coordMin) {
        if (positive.indices == null) positive.indices = [];
        positive.indices.push(indices[n]);
        indices[n] = -1;
      }
    }
    compactIndices(node, indices, numObjects);
    if (node.splitIndices != null) {
      node.splitTree = new CollisionKdTree2D(this, node);
      node.splitTree.createTree();
    }
    if (negative.indices != null) this.splitNode(negative);
    if (positive.indices != null) this.splitNode(positive);
  }
}

export class CollisionKdTree2D {
  threshold = 0.1; // §&!@§
  minPrimitivesPerNode = 1; // § !i§
  parentTree: CollisionKdTree; // §@T§
  parentNode: CollisionKdNode; // §-"7§
  rootNode: CollisionKdNode = null as unknown as CollisionKdNode; // §#T§
  private readonly search = new SplitSearch();

  constructor(parentTree: CollisionKdTree, parentNode: CollisionKdNode) {
    this.parentTree = parentTree;
    this.parentNode = parentNode;
  }

  createTree(): void {
    this.rootNode = new CollisionKdNode();
    this.rootNode.boundBox = this.parentNode.boundBox.clone();
    const indices: number[] = [];
    this.rootNode.indices = indices;
    const splitIndices = this.parentNode.splitIndices as number[];
    const count = splitIndices.length;
    for (let n = 0; n < count; n++) indices[n] = splitIndices[n];
    this.splitNode(this.rootNode);
    splitCoordsX.length = splitCoordsY.length = splitCoordsZ.length = 0;
  }

  private splitNode(node: CollisionKdNode): void {
    if ((node.indices as number[]).length <= this.minPrimitivesPerNode) return;
    const indices = node.indices as number[];
    const nodeBoundBox = node.boundBox;
    shrinkBoundBox(nodeBoundBox, this.threshold);
    const boxes = this.parentTree.staticBoundBoxes;
    const parentAxis = this.parentNode.axis;
    let numX = 0;
    let numY = 0;
    let numZ = 0;
    const numObjects = indices.length;
    for (let n = 0; n < numObjects; n++) {
      const bb = boxes[indices[n]];
      if (parentAxis != 0) {
        if (bb.minX > boundBox.minX) splitCoordsX[numX++] = bb.minX;
        if (bb.maxX < boundBox.maxX) splitCoordsX[numX++] = bb.maxX;
      }
      if (parentAxis != 1) {
        if (bb.minY > boundBox.minY) splitCoordsY[numY++] = bb.minY;
        if (bb.maxY < boundBox.maxY) splitCoordsY[numY++] = bb.maxY;
      }
      if (parentAxis != 2) {
        if (bb.minZ > boundBox.minZ) splitCoordsZ[numZ++] = bb.minZ;
        if (bb.maxZ < boundBox.maxZ) splitCoordsZ[numZ++] = bb.maxZ;
      }
    }
    const search = this.search;
    search.splitAxis = -1;
    search.splitCost = 1e308;
    fillNodeBB(nodeBoundBox);
    if (parentAxis != 0) search.check(this.threshold, boxes, node, 0, numX, splitCoordsX, nodeBB);
    if (parentAxis != 1) search.check(this.threshold, boxes, node, 1, numY, splitCoordsY, nodeBB);
    if (parentAxis != 2) search.check(this.threshold, boxes, node, 2, numZ, splitCoordsZ, nodeBB);
    if (search.splitAxis < 0) return;
    const axisX = search.splitAxis == 0;
    const axisY = search.splitAxis == 1;
    const splitCoord = search.splitCoord;
    createChildren(node, nodeBoundBox, search.splitAxis, splitCoord);
    const negative = node.negativeNode as CollisionKdNode;
    const positive = node.positiveNode as CollisionKdNode;
    const coordMin = splitCoord - this.threshold;
    const coordMax = splitCoord + this.threshold;
    for (let n = 0; n < numObjects; n++) {
      const bb = boxes[indices[n]];
      const min = axisX ? bb.minX : axisY ? bb.minY : bb.minZ;
      const max = axisX ? bb.maxX : axisY ? bb.maxY : bb.maxZ;
      if (max <= coordMax) {
        if (min < coordMin) {
          if (negative.indices == null) negative.indices = [];
          negative.indices.push(indices[n]);
          indices[n] = -1;
        }
      } else if (min >= coordMin) {
        if (max > coordMax) {
          if (positive.indices == null) positive.indices = [];
          positive.indices.push(indices[n]);
          indices[n] = -1;
        }
      }
    }
    compactIndices(node, indices, numObjects);
    if (negative.indices != null) this.splitNode(negative);
    if (positive.indices != null) this.splitNode(positive);
  }
}
