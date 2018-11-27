import { Fork } from "../types";
import typesPlugin, { ASTNode } from "./types";

var Op = Object.prototype;
var hasOwn = Op.hasOwnProperty;

export interface Path<V = any> {
  value: V;
  parentPath: any;
  name: any;
  getValueProperty(name: any): any;
  get(...names: any[]): any;
  each(callback: any, context: any): any;
  map(callback: any, context: any): any;
  filter(callback: any, context: any): any;
  shift(): any;
  unshift(...args: any[]): any;
  push(...args: any[]): any;
  pop(): any;
  insertAt(index: number, ...args: any[]): any;
  insertBefore(...args: any[]): any;
  insertAfter(...args: any[]): any;
  replace(replacement?: V, ...args: ASTNode[]): any;
}

export interface PathConstructor {
  new<V = any>(value: V, parentPath?: any, name?: any): Path<V>;
}

export default function pathPlugin(fork: Fork): PathConstructor {
  var types = fork.use(typesPlugin);
  var isArray = types.builtInTypes.array;
  var isNumber = types.builtInTypes.number;

  class PathImpl<V extends { [name: string]: any } = {}> implements Path<V> {
    value: V;
    parentPath: any;
    name: any;
    __childCache: object | null;

    constructor(value: V, parentPath?: any, name?: any) {
      if (!(this instanceof PathImpl)) {
        throw new Error("Path constructor cannot be invoked without 'new'");
      }

      if (parentPath) {
        if (!(parentPath instanceof PathImpl)) {
          throw new Error("");
        }
      } else {
        parentPath = null;
        name = null;
      }

      // The value encapsulated by this Path, generally equal to
      // parentPath.value[name] if we have a parentPath.
      this.value = value;

      // The immediate parent Path of this Path.
      this.parentPath = parentPath;

      // The name of the property of parentPath.value through which this
      // Path's value was reached.
      this.name = name;

      // Calling path.get("child") multiple times always returns the same
      // child Path object, for both performance and consistency reasons.
      this.__childCache = null;
    }

    // This method is designed to be overridden by subclasses that need to
    // handle missing properties, etc.
    getValueProperty(name: any) {
      return this.value[name];
    }

    get(...names: (string | number)[]) {
      var path = this;
      var count = names.length;

      for (var i = 0; i < count; ++i) {
        path = getChildPath(path, names[i]);
      }

      return path;
    }

    each(callback: any, context: any) {
      var childPaths = [];
      var len = this.value.length;
      var i = 0;

      // Collect all the original child paths before invoking the callback.
      for (var i = 0; i < len; ++i) {
        if (hasOwn.call(this.value, i)) {
          childPaths[i] = this.get(i);
        }
      }

      // Invoke the callback on just the original child paths, regardless of
      // any modifications made to the array by the callback. I chose these
      // semantics over cleverly invoking the callback on new elements because
      // this way is much easier to reason about.
      context = context || this;
      for (i = 0; i < len; ++i) {
        if (hasOwn.call(childPaths, i)) {
          callback.call(context, childPaths[i]);
        }
      }
    }

    map(callback: any, context: any) {
      var result: any[] = [];

      this.each(function (this: any, childPath: any) {
        result.push(callback.call(this, childPath));
      }, context);

      return result;
    }

    filter(callback: any, context: any) {
      var result: any[] = [];

      this.each(function (this: any, childPath: any) {
        if (callback.call(this, childPath)) {
          result.push(childPath);
        }
      }, context);

      return result;
    }

    shift() {
      var move = getMoves(this, -1);
      var result = this.value.shift();
      move();
      return result;
    }

    unshift(...args: any[]) {
      var move = getMoves(this, args.length);
      var result = this.value.unshift.apply(this.value, args);
      move();
      return result;
    }

    push(...args: any[]) {
      isArray.assert(this.value);
      delete getChildCache(this).length
      return this.value.push.apply(this.value, args);
    }

    pop() {
      isArray.assert(this.value);
      var cache = getChildCache(this);
      delete cache[this.value.length - 1];
      delete cache.length;
      return this.value.pop();
    }

    insertAt(index: number) {
      var argc = arguments.length;
      var move = getMoves(this, argc - 1, index);
      if (move === emptyMoves) {
        return this;
      }

      index = Math.max(index, 0);

      for (var i = 1; i < argc; ++i) {
        this.value[index + i - 1] = arguments[i];
      }

      move();

      return this;
    }

    insertBefore(...args: any[]) {
      var pp = this.parentPath;
      var argc = args.length;
      var insertAtArgs = [this.name];
      for (var i = 0; i < argc; ++i) {
        insertAtArgs.push(args[i]);
      }
      return pp.insertAt.apply(pp, insertAtArgs);
    }

    insertAfter(...args: any[]) {
      var pp = this.parentPath;
      var argc = args.length;
      var insertAtArgs = [this.name + 1];
      for (var i = 0; i < argc; ++i) {
        insertAtArgs.push(args[i]);
      }
      return pp.insertAt.apply(pp, insertAtArgs);
    }

    replace(replacement?: V) {
      var results = [];
      var parentValue = this.parentPath.value;
      var parentCache = getChildCache(this.parentPath);
      var count = arguments.length;

      repairRelationshipWithParent(this);

      if (isArray.check(parentValue)) {
        var originalLength = parentValue.length;
        var move = getMoves(this.parentPath, count - 1, this.name + 1);

        var spliceArgs = [this.name, 1];
        for (var i = 0; i < count; ++i) {
          spliceArgs.push(arguments[i]);
        }

        var splicedOut = parentValue.splice.apply(parentValue, spliceArgs);

        if (splicedOut[0] !== this.value) {
          throw new Error("");
        }
        if (parentValue.length !== (originalLength - 1 + count)) {
          throw new Error("");
        }

        move();

        if (count === 0) {
          delete this.value;
          delete parentCache[this.name];
          this.__childCache = null;

        } else {
          if (parentValue[this.name] !== replacement) {
            throw new Error("");
          }

          if (this.value !== replacement) {
            this.value = replacement!;
            this.__childCache = null;
          }

          for (i = 0; i < count; ++i) {
            results.push(this.parentPath.get(this.name + i));
          }

          if (results[0] !== this) {
            throw new Error("");
          }
        }

      } else if (count === 1) {
        if (this.value !== replacement) {
          this.__childCache = null;
        }
        this.value = parentValue[this.name] = replacement!;
        results.push(this);

      } else if (count === 0) {
        delete parentValue[this.name];
        delete this.value;
        this.__childCache = null;

        // Leave this path cached as parentCache[this.name], even though
        // it no longer has a value defined.

      } else {
        throw new Error("Could not replace path");
      }

      return results;
    }
  };

  function getChildCache(path: PathImpl) {
    // Lazily create the child cache. This also cheapens cache
    // invalidation, since you can just reset path.__childCache to null.
    return path.__childCache || (path.__childCache = Object.create(null));
  }

  function getChildPath(path: any, name: any) {
    var cache = getChildCache(path);
    var actualChildValue = path.getValueProperty(name);
    var childPath = cache[name];
    if (!hasOwn.call(cache, name) ||
      // Ensure consistency between cache and reality.
      childPath.value !== actualChildValue) {
      childPath = cache[name] = new path.constructor(
        actualChildValue, path, name
      );
    }
    return childPath;
  }

  function emptyMoves() {}
  function getMoves(path: any, offset: number, start?: any, end?: any) {
    isArray.assert(path.value);

    if (offset === 0) {
      return emptyMoves;
    }

    var length = path.value.length;
    if (length < 1) {
      return emptyMoves;
    }

    var argc = arguments.length;
    if (argc === 2) {
      start = 0;
      end = length;
    } else if (argc === 3) {
      start = Math.max(start, 0);
      end = length;
    } else {
      start = Math.max(start, 0);
      end = Math.min(end, length);
    }

    isNumber.assert(start);
    isNumber.assert(end);

    var moves = Object.create(null);
    var cache = getChildCache(path);

    for (var i = start; i < end; ++i) {
      if (hasOwn.call(path.value, i)) {
        var childPath = path.get(i);
        if (childPath.name !== i) {
          throw new Error("");
        }
        var newIndex = i + offset;
        childPath.name = newIndex;
        moves[newIndex] = childPath;
        delete cache[i];
      }
    }

    delete cache.length;

    return function () {
      for (var newIndex in moves) {
        var childPath = moves[newIndex];
        if (childPath.name !== +newIndex) {
          throw new Error("");
        }
        cache[newIndex] = childPath;
        path.value[newIndex] = childPath.value;
      }
    };
  }

  function repairRelationshipWithParent(path: any) {
    if (!(path instanceof PathImpl)) {
      throw new Error("");
    }

    var pp = path.parentPath;
    if (!pp) {
      // Orphan paths have no relationship to repair.
      return path;
    }

    var parentValue = pp.value;
    var parentCache = getChildCache(pp);

    // Make sure parentCache[path.name] is populated.
    if (parentValue[path.name] === path.value) {
      parentCache[path.name] = path;
    } else if (isArray.check(parentValue)) {
      // Something caused path.name to become out of date, so attempt to
      // recover by searching for path.value in parentValue.
      var i = parentValue.indexOf(path.value);
      if (i >= 0) {
        parentCache[path.name = i] = path;
      }
    } else {
      // If path.value disagrees with parentValue[path.name], and
      // path.name is not an array index, let path.value become the new
      // parentValue[path.name] and update parentCache accordingly.
      parentValue[path.name] = path.value;
      parentCache[path.name] = path;
    }

    if (parentValue[path.name] !== path.value) {
      throw new Error("");
    }
    if (path.parentPath.get(path.name) !== path) {
      throw new Error("");
    }

    return path;
  }

  return PathImpl;
};
