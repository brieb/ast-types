import { Fork, Omit } from "../types";
import typesPlugin, { ASTNode } from "./types";
import nodePathPlugin, { NodePath } from "./node-path";

var hasOwn = Object.prototype.hasOwnProperty;

export interface PathVisitor {
  Context: any;
  visit(...args: any[]): any;
  reset(path: any, ...args: any[]): any;
  visitWithoutReset(path: any): any;
  AbortRequest: any;
  abort(): void;
  acquireContext(path: any): any;
  releaseContext(context: any): void;
  reportChanged(): void;
  wasChangeReported(): any;
}

export interface PathVisitorStatics {
  fromMethodsObject(methods?: any): Visitor;
  visit(node: ASTNode, methods?: any): any;
}

export interface PathVisitorConstructor extends PathVisitorStatics {
  new(): PathVisitor;
}

export interface Visitor extends PathVisitor {}

export interface VisitorConstructor extends PathVisitorStatics {
  new(): Visitor;
}

export interface VisitorMethods {
  [visitorMethod: string]: (path: NodePath) => any;
}

export interface SharedContextMethods {
  currentPath: NodePath | null;
  needToCallTraverse: boolean;
  Context: any;
  visitor: PathVisitor & VisitorMethods;
  reset(path: any, ...args: any[]): any;
  invokeVisitorMethod(methodName: string): any;
  traverse(path: any, newVisitor?: VisitorMethods): any;
  visit(path: any, newVisitor?: VisitorMethods): any;
  reportChanged(): void;
  abort(): void;
}

export interface Context extends Omit<PathVisitor, "visit">, SharedContextMethods {}

export interface ContextConstructor {
  new(path: NodePath): Context;
}

export default function pathVisitorPlugin(fork: Fork): PathVisitorConstructor {
  var types = fork.use(typesPlugin);
  var NodePath = fork.use(nodePathPlugin);
  var isArray = types.builtInTypes.array;
  var isObject = types.builtInTypes.object;
  var isFunction = types.builtInTypes.function;
  var undefined: any;

  class PathVisitorImpl implements PathVisitor {
    static fromMethodsObject(methods?: any) {
      if (methods instanceof PathVisitorImpl) {
        return methods;
      }

      if (!isObject.check(methods)) {
        // An empty visitor?
        return new PathVisitorImpl();
      }

      class VisitorImpl extends PathVisitorImpl implements Visitor {
        constructor() {
          super();
          if (!(this instanceof VisitorImpl)) {
            throw new Error("Visitor constructor cannot be invoked without 'new'");
          }
        }
      }

      extend(VisitorImpl.prototype, methods);

      isFunction.assert(VisitorImpl.fromMethodsObject);
      isFunction.assert(VisitorImpl.visit);

      return new VisitorImpl();
    }

    static visit(node: ASTNode, methods?: any) {
      return PathVisitorImpl.fromMethodsObject(methods).visit(node);
    }

    _reusableContextStack: any;
    _methodNameTable: any;
    _shouldVisitComments: any;
    Context: ContextConstructor;
    _visiting: any;
    _changeReported: boolean;
    _abortRequested: boolean;

    constructor() {
      if (!(this instanceof PathVisitorImpl)) {
        throw new Error(
          "PathVisitor constructor cannot be invoked without 'new'"
        );
      }

      // Permanent state.
      this._reusableContextStack = [];

      this._methodNameTable = computeMethodNameTable(this);
      this._shouldVisitComments =
        hasOwn.call(this._methodNameTable, "Block") ||
        hasOwn.call(this._methodNameTable, "Line");

      this.Context = makeContextConstructor(this);

      // State reset every time PathVisitor.prototype.visit is called.
      this._visiting = false;
      this._changeReported = false;
    }

    visit(...args: any[]): any {
      if (this._visiting) {
        throw new Error(
          "Recursively calling visitor.visit(path) resets visitor state. " +
          "Try this.visit(path) or this.traverse(path) instead."
        );
      }

      // Private state that needs to be reset before every traversal.
      this._visiting = true;
      this._changeReported = false;
      this._abortRequested = false;

      var argc = arguments.length;
      var args = new Array(argc)
      for (var i = 0; i < argc; ++i) {
        args[i] = arguments[i];
      }

      if (!(args[0] instanceof NodePath)) {
        args[0] = new NodePath({root: args[0]}).get("root");
      }

      // Called with the same arguments as .visit.
      this.reset.apply(this, args);

      var didNotThrow;
      try {
        var root = this.visitWithoutReset(args[0]);
        didNotThrow = true;
      } finally {
        this._visiting = false;

        if (!didNotThrow && this._abortRequested) {
          // If this.visitWithoutReset threw an exception and
          // this._abortRequested was set to true, return the root of
          // the AST instead of letting the exception propagate, so that
          // client code does not have to provide a try-catch block to
          // intercept the AbortRequest exception.  Other kinds of
          // exceptions will propagate without being intercepted and
          // rethrown by a catch block, so their stacks will accurately
          // reflect the original throwing context.
          return args[0].value;
        }
      }

      return root;
    }

    AbortRequest = class AbortRequest {
      cancel() {}
    };

    abort(): void {
      var visitor = this;
      visitor._abortRequested = true;
      var request = new visitor.AbortRequest();

      // If you decide to catch this exception and stop it from propagating,
      // make sure to call its cancel method to avoid silencing other
      // exceptions that might be thrown later in the traversal.
      request.cancel = function () {
        visitor._abortRequested = false;
      };

      throw request;
    }

    reset() {
      // Empty stub; may be reassigned or overridden by subclasses.
    }

    visitWithoutReset(path: any): any {
      if (this instanceof this.Context) {
        // Since this.Context.prototype === this, there's a chance we
        // might accidentally call context.visitWithoutReset. If that
        // happens, re-invoke the method against context.visitor.
        return (this as any as Context).visitor.visitWithoutReset(path);
      }

      if (!(path instanceof NodePath)) {
        throw new Error("");
      }

      var value = path.value;

      var methodName = value &&
        typeof value === "object" &&
        typeof value.type === "string" &&
        this._methodNameTable[value.type];

      if (methodName) {
        var context = this.acquireContext(path);
        try {
          return context.invokeVisitorMethod(methodName);
        } finally {
          this.releaseContext(context);
        }

      } else {
        // If there was no visitor method to call, visit the children of
        // this node generically.
        return visitChildren(path, this);
      }
    }

    acquireContext(path: any) {
      if (this._reusableContextStack.length === 0) {
        return new this.Context(path);
      }
      return this._reusableContextStack.pop().reset(path);
    }

    releaseContext(context: any) {
      if (!(context instanceof this.Context)) {
        throw new Error("");
      }
      this._reusableContextStack.push(context);
      context.currentPath = null;
    }

    reportChanged() {
      this._changeReported = true;
    }

    wasChangeReported() {
      return this._changeReported;
    }
  }

  function computeMethodNameTable(visitor: any) {
    var typeNames = Object.create(null);

    for (var methodName in visitor) {
      if (/^visit[A-Z]/.test(methodName)) {
        typeNames[methodName.slice("visit".length)] = true;
      }
    }

    var supertypeTable = types.computeSupertypeLookupTable(typeNames);
    var methodNameTable = Object.create(null);

    var typeNameKeys = Object.keys(supertypeTable);
    var typeNameCount = typeNameKeys.length;
    for (var i = 0; i < typeNameCount; ++i) {
      var typeName = typeNameKeys[i];
      methodName = "visit" + supertypeTable[typeName];
      if (isFunction.check(visitor[methodName])) {
        methodNameTable[typeName] = methodName;
      }
    }

    return methodNameTable;
  }

  function extend(target: any, source: any) {
    for (var property in source) {
      if (hasOwn.call(source, property)) {
        target[property] = source[property];
      }
    }

    return target;
  }

  function visitChildren(path: any, visitor: any) {
    if (!(path instanceof NodePath)) {
      throw new Error("");
    }
    if (!(visitor instanceof PathVisitorImpl)) {
      throw new Error("");
    }

    var value = path.value;

    if (isArray.check(value)) {
      path.each(visitor.visitWithoutReset, visitor);
    } else if (!isObject.check(value)) {
      // No children to visit.
    } else {
      var childNames = types.getFieldNames(value);

      // The .comments field of the Node type is hidden, so we only
      // visit it if the visitor defines visitBlock or visitLine, and
      // value.comments is defined.
      if (visitor._shouldVisitComments &&
        value.comments &&
        childNames.indexOf("comments") < 0) {
        childNames.push("comments");
      }

      var childCount = childNames.length;
      var childPaths = [];

      for (var i = 0; i < childCount; ++i) {
        var childName = childNames[i];
        if (!hasOwn.call(value, childName)) {
          value[childName] = types.getFieldValue(value, childName);
        }
        childPaths.push(path.get(childName));
      }

      for (var i = 0; i < childCount; ++i) {
        visitor.visitWithoutReset(childPaths[i]);
      }
    }

    return path.value;
  }

  function makeContextConstructor(visitor: PathVisitor) {
    class ContextImpl implements PathVisitor, SharedContextMethods {
      currentPath: NodePath | null;
      needToCallTraverse: boolean;
      visitor: PathVisitor & VisitorMethods;

      constructor(path: NodePath) {
        if (!(this instanceof ContextImpl)) {
          throw new Error("");
        }
        if (!(this instanceof PathVisitorImpl)) {
          throw new Error("");
        }
        if (!(path instanceof NodePath)) {
          throw new Error("");
        }
  
        Object.defineProperty(this, "visitor", {
          value: visitor,
          writable: false,
          enumerable: true,
          configurable: false
        });
  
        this.currentPath = path;
        this.needToCallTraverse = true;
  
        Object.seal(this);
      }

      // PathVisitor mixed in later
      Context: any;
      visit: any;
      reset: any;
      visitWithoutReset: any;
      AbortRequest: any;
      abort: any;
      acquireContext: any;
      releaseContext: any;
      reportChanged: any;
      wasChangeReported: any;

      // SharedContextMethods
      invokeVisitorMethod: any;
      traverse: any;
    }

    if (!(visitor instanceof PathVisitorImpl)) {
      throw new Error("");
    }

    // Note that the visitor object is the prototype of Context.prototype,
    // so all visitor methods are inherited by context objects.
    var Cp = ContextImpl.prototype = Object.create(visitor);

    Cp.constructor = ContextImpl;
    extend(Cp, sharedContextProtoMethods);

    return ContextImpl as ContextConstructor;
  }

  // Every PathVisitor has a different this.Context constructor and
  // this.Context.prototype object, but those prototypes can all use the
  // same reset, invokeVisitorMethod, and traverse function objects.
  var sharedContextProtoMethods: SharedContextMethods = Object.create(null);

  sharedContextProtoMethods.reset = function reset(path) {
    if (!(this instanceof this.Context)) {
      throw new Error("");
    }
    if (!(path instanceof NodePath)) {
      throw new Error("");
    }

    this.currentPath = path;
    this.needToCallTraverse = true;

    return this;
  };

  sharedContextProtoMethods.invokeVisitorMethod = function invokeVisitorMethod(methodName) {
    if (!(this instanceof this.Context)) {
      throw new Error("");
    }
    if (!(this.currentPath instanceof NodePath)) {
      throw new Error("");
    }

    var result = this.visitor[methodName].call(this, this.currentPath);

    if (result === false) {
      // Visitor methods return false to indicate that they have handled
      // their own traversal needs, and we should not complain if
      // this.needToCallTraverse is still true.
      this.needToCallTraverse = false;

    } else if (result !== undefined) {
      // Any other non-undefined value returned from the visitor method
      // is interpreted as a replacement value.
      this.currentPath = this.currentPath.replace(result)[0];

      if (this.needToCallTraverse) {
        // If this.traverse still hasn't been called, visit the
        // children of the replacement node.
        this.traverse(this.currentPath);
      }
    }

    if (this.needToCallTraverse !== false) {
      throw new Error(
      "Must either call this.traverse or return false in " + methodName
      );
    }

    var path = this.currentPath;
    return path && path.value;
  };

  sharedContextProtoMethods.traverse = function traverse(path, newVisitor) {
    if (!(this instanceof this.Context)) {
      throw new Error("");
    }
    if (!(path instanceof NodePath)) {
      throw new Error("");
    }
    if (!(this.currentPath instanceof NodePath)) {
      throw new Error("");
    }

    this.needToCallTraverse = false;

    return visitChildren(path, PathVisitorImpl.fromMethodsObject(
      newVisitor || this.visitor
    ));
  };

  sharedContextProtoMethods.visit = function visit(path, newVisitor) {
    if (!(this instanceof this.Context)) {
      throw new Error("");
    }
    if (!(path instanceof NodePath)) {
      throw new Error("");
    }
    if (!(this.currentPath instanceof NodePath)) {
      throw new Error("");
    }

    this.needToCallTraverse = false;

    return PathVisitorImpl.fromMethodsObject(
    newVisitor || this.visitor
    ).visitWithoutReset(path);
  };

  sharedContextProtoMethods.reportChanged = function reportChanged() {
    this.visitor.reportChanged();
  };

  sharedContextProtoMethods.abort = function abort() {
    this.needToCallTraverse = false;
    this.visitor.abort();
  };

  return PathVisitorImpl;
};
