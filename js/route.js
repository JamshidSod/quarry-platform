// Shortest ways along the network from one point on it.
import { slice } from "./network.js";

/** A binary heap of [cost, node]. */
class Heap {
  constructor() { this.items = []; }
  get size() { return this.items.length; }
  push(item) {
    const a = this.items;
    a.push(item);
    for (let i = a.length - 1; i > 0;) {
      const p = (i - 1) >> 1;
      if (a[p][0] <= a[i][0]) break;
      [a[p], a[i]] = [a[i], a[p]]; i = p;
    }
  }
  pop() {
    const a = this.items, top = a[0], last = a.pop();
    if (a.length) {
      a[0] = last;
      for (let i = 0; ;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < a.length && a[l][0] < a[m][0]) m = l;
        if (r < a.length && a[r][0] < a[m][0]) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]]; i = m;
      }
    }
    return top;
  }
}

/**
 * Metres along the roads from a network point to every node.
 * prev[n] is the node before n on its shortest way (-1 where the way starts on the point's own edge),
 * prevEdge[n] the edge used to reach n.
 */
export function distancesFrom(net, from) {
  const n = net.nodes.length / 2;
  const dist = new Float64Array(n).fill(Infinity), prev = new Int32Array(n).fill(-1), prevEdge = new Int32Array(n).fill(-1);
  const e = net.edges[from.edge], heap = new Heap();
  const seed = (node, cost) => { if (cost < dist[node]) { dist[node] = cost; prevEdge[node] = from.edge; heap.push([cost, node]); } };
  seed(e.a, from.t * e.length);
  seed(e.b, (1 - from.t) * e.length);
  while (heap.size) {
    const [cost, node] = heap.pop();
    if (cost > dist[node]) continue;
    for (const [next, length, edge] of net.adjacency[node]) {
      const c = cost + length;
      if (c < dist[next]) { dist[next] = c; prev[next] = node; prevEdge[next] = edge; heap.push([c, next]); }
    }
  }
  return { dist, prev, prevEdge };
}

/** How the shortest way reaches a target point: along the shared edge, or through one end of the target's edge. */
function arrival(net, tree, from, to) {
  const e = net.edges[to.edge];
  let best = { metres: tree.dist[e.a] + to.t * e.length, via: e.a, t: 0 };
  const throughB = tree.dist[e.b] + (1 - to.t) * e.length;
  if (throughB < best.metres) best = { metres: throughB, via: e.b, t: 1 };
  if (from.edge === to.edge) {
    const along = Math.abs(from.t - to.t) * e.length;
    if (along <= best.metres) best = { metres: along, via: -1, t: from.t };
  }
  return best;
}

/** Shortest distance in metres along the network between two points on it. */
export function onRoadM(net, tree, from, to) {
  return arrival(net, tree, from, to).metres;
}

/** The shortest way between two network points as [[lon, lat], ...], from `from` to `to`. */
export function pathGeometry(net, tree, from, to) {
  const reach = arrival(net, tree, from, to);
  if (reach.via === -1) return slice(net, to.edge, from.t, to.t);

  const nodes = [];
  for (let n = reach.via; n !== -1; n = tree.prev[n]) nodes.push(n);
  nodes.reverse();                                   // first node is an end of the starting edge

  const start = net.edges[from.edge];
  // a loop edge has both ends at one node: leave it by the shorter side
  const leaveAtA = start.a === start.b ? from.t <= 0.5 : nodes[0] === start.a;
  const points = slice(net, from.edge, from.t, leaveAtA ? 0 : 1);
  for (let i = 1; i < nodes.length; i++) {
    const edge = tree.prevEdge[nodes[i]], forward = net.edges[edge].a === nodes[i - 1];
    points.push(...slice(net, edge, forward ? 0 : 1, forward ? 1 : 0).slice(1));
  }
  points.push(...slice(net, to.edge, reach.t, to.t).slice(1));
  return points;
}
