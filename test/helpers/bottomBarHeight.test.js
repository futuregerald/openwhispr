const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/helpers/bottomBarHeight.js");

const makeBar = (heights) => {
  const properties = new Map();
  const host = {
    style: {
      setProperty: (name, value) => properties.set(name, value),
      removeProperty: (name) => properties.delete(name),
    },
  };
  let index = 0;
  return {
    properties,
    bar: {
      parentElement: host,
      getBoundingClientRect: () => ({ height: heights[Math.min(index++, heights.length - 1)] }),
    },
  };
};

const makeObserverClass = () => {
  const instances = [];
  class FakeObserver {
    constructor(callback) {
      this.callback = callback;
      this.observed = [];
      this.disconnected = false;
      instances.push(this);
    }
    observe(target) {
      this.observed.push(target);
    }
    disconnect() {
      this.disconnected = true;
    }
  }
  return { FakeObserver, instances };
};

test("the bar's height is published on its parent straight away and on every resize", async () => {
  const { publishBottomBarHeight, BOTTOM_BAR_HEIGHT_VARIABLE } = await load();
  const { bar, properties } = makeBar([80, 150]);
  const { FakeObserver, instances } = makeObserverClass();

  publishBottomBarHeight(bar, FakeObserver);
  assert.equal(properties.get(BOTTOM_BAR_HEIGHT_VARIABLE), "80px");
  assert.deepEqual(instances[0].observed, [bar]);

  instances[0].callback();
  assert.equal(properties.get(BOTTOM_BAR_HEIGHT_VARIABLE), "150px");
});

test("cleaning up disconnects the observer and removes the variable", async () => {
  const { publishBottomBarHeight, BOTTOM_BAR_HEIGHT_VARIABLE } = await load();
  const { bar, properties } = makeBar([80]);
  const { FakeObserver, instances } = makeObserverClass();

  const cleanup = publishBottomBarHeight(bar, FakeObserver);
  cleanup();

  assert.equal(instances[0].disconnected, true);
  assert.equal(properties.has(BOTTOM_BAR_HEIGHT_VARIABLE), false);
});

test("a missing bar, parent or ResizeObserver does nothing and still returns a cleanup", async () => {
  const { publishBottomBarHeight } = await load();
  const { FakeObserver } = makeObserverClass();
  for (const cleanup of [
    publishBottomBarHeight(null, FakeObserver),
    publishBottomBarHeight({ parentElement: null }, FakeObserver),
    publishBottomBarHeight(makeBar([10]).bar, undefined),
  ]) {
    assert.doesNotThrow(cleanup);
  }
});
