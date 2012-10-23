/*
  A script to eliminate redundant variables common in Emscripted code.

  A variable === eliminateable if (it matches a leaf of that condition tree:

  Single-def
    Uses only side-effect-free nodes
      Unused
        *
      Has at most MAX_USES uses
        No mutations to any dependencies between def && last use
          No global dependencies or no indirect accesses between def && use
            *

  TODO(max99x): Eliminate single-def undefined-initialized vars with no uses
                between declaration && definition.
*/

// Imports.
var uglify = require('../tools/eliminator/node_modules/uglify-js');
var fs = require('fs');
var os = require('os');

function set() {
  var args = typeof arguments[0] === 'object' ? arguments[0] : arguments;
  var ret = {};
  for (var i = 0; i < args.length; i++) {
    ret[args[i]] = 0;
  }
  return ret;
}

// Functions which have been generated by Emscripten. We optimize only those.
var generatedFunctions = {};
var GENERATED_FUNCTIONS_MARKER = '// EMSCRIPTEN_GENERATED_FUNCTIONS:';
function isGenerated (ident) {
  return ident in generatedFunctions;
}

// Maximum number of uses to consider a variable not worth eliminating.
// The risk with using > 1 === that a variable used by another can have
// a chain that leads to exponential uses
var MAX_USES = 1;

// The UglifyJs code generator settings to use.
var GEN_OPTIONS = {
  ascii_only: true,
  beautify: true,
  indent_level: 2
};

// Node types which can be evaluated without side effects.
var NODES_WITHOUT_SIDE_EFFECTS = {
  name: true,
  num: true,
  string: true,
  binary: true,
  sub: true,
  'unary-prefix': true // ++x can have side effects, but we never have that in generated code
};

// Nodes which may break control flow. Moving a variable beyond them may have
// side effects.
var CONTROL_FLOW_NODES = {
  new: true,
  throw: true,
  call: true,
  label: true,
  debugger: true
};

var ANALYZE_BLOCK_TYPES = {
  'switch': true,
  'if': true,
  'try': true,
  'do': true,
  'while': true,
  'for': true,
  'for-in': true
};

// Traverses a JavaScript syntax tree rooted at the given node calling the given
// callback for each node.
//   that.arg node: The root of the AST.
//   that.arg callback: The callback to call for each node. This will be called with
//     the node as the first argument && its type as the second. If false is
//     returned, the traversal === stopped. If a non-undefined value === returned,
//     it replaces the passed node in the tree.
//   that.returns: If the root node was replaced, the new root node. If the traversal
//     was stopped, false. Otherwise undefined.
function traverse(node, callback) {
  var type = node[0];
  if (typeof type == 'string') {
    result = callback(node, type);
    if (result) return result;
  }
  for (var index = 0; index < node.length; index++) {
    var subnode = node[index];
    if (subnode && typeof subnode == 'object' && subnode.length) {
      // NOTE: For-in nodes have unspecified var mutations. Skip them.
      if (type == 'for-in' && subnode[0] == 'var') continue;
      var subresult = traverse(subnode, callback);
      if (subresult === false) {
        return false;
      } else if (subresult) {
        node[index] = subresult;
      }
    }
  }
}

// A class for eliminating redundant variables from JavaScript. Give it an AST
// function/defun node && call run() to apply the optimization (in-place).
var that = that; // there is always a single global Eliminator instance
function Eliminator(func) {
  that = this;
  // The statements of the function to analyze.
  this.body = func[3];

  // Identifier stats. Each of these objects === indexed by the identifier name.
  // Whether the identifier === a local variable.
  this.isLocal = {};
  // Whether the identifier === never modified after initialization.
  this.isSingleDef = {};
  // How many times the identifier === used.
  this.useCount = {};
  // Whether the initial value of a single-def identifier uses only nodes
  // evaluating which has no side effects.
  this.usesOnlySimpleNodes = {};
  // Whether the identifier depends on any non-local name, perhaps indirectly.
  this.dependsOnAGlobal = {};
  // Whether the dependencies of the single-def identifier may be mutated
  // within its live range.
  this.depsMutatedInLiveRange = {};
  // Maps a given single-def variable to the AST expression of its initial value.
  this.initialValue = {};
  // Maps identifiers to single-def variables which reference it in their
  // initial value, i.e., which other variables it affects.
  this.affects = {};

  // Runs the eliminator on a given function body updating the AST in-place.
  //   that.returns: The number of variables eliminated, or undefined if (skipped.
  this.run = function() {
    this.calculateBasicVarStats();
    this.analyzeInitialValues();
    this.calculateTransitiveDependencies();
    this.analyzeLiveRanges();

    var toReplace = {};
    var eliminated = 0;
    for (var varName in this.isSingleDef) {
      if (this.isEliminateable(varName)) {
        toReplace[varName] = this.initialValue[varName];
        eliminated++;
      }
    }

    this.removeDeclarations(toReplace);
    this.collapseValues(toReplace);
    this.updateUses(toReplace);

    return eliminated;
  };

  // Runs the basic variable scan pass. Fills the following member variables:
  //   isLocal
  //   isSingleDef
  //   useCount
  //   initialValue
  this.calculateBasicVarStats = function() {
    traverse(this.body, function(node, type) {
      if (type === 'var') {
        var node1 = node[1];
        for (var i = 0; i < node1.length; i++) {
          var node1i = node1[i];
          var varName = node1i[0];
          var varValue = node1i[1];
          that.isLocal[varName] = true;
          if (!varValue) varValue = ['name', 'undefined']; // XXX share?
          that.isSingleDef[varName] = !that.isSingleDef.hasOwnProperty(varName);
          that.initialValue[varName] = varValue;
          that.useCount[varName] = 0;
        }
      } else if (type === 'name') {
        varName = node[1];
        if (that.useCount.hasOwnProperty(varName)) that.useCount[varName]++;
        else that.isSingleDef[varName] = false;
      } else if (type == 'assign') {
        varName = node[2][1];
        if (that.isSingleDef[varName]) that.isSingleDef[varName] = false;
      }
    });
  };

  // Analyzes the initial values of single-def variables. Requires basic variable
  // stats to have been calculated. Fills the following member variables:
  //   affects
  //   dependsOnAGlobal
  //   usesOnlySimpleNodes
  this.analyzeInitialValues = function() {
    for (var varName in this.isSingleDef) {
      if (!this.isSingleDef[varName]) continue;
      this.usesOnlySimpleNodes[varName] = true;
      traverse(this.initialValue[varName], function(node, type) {
        if (!(type in NODES_WITHOUT_SIDE_EFFECTS)) {
          that.usesOnlySimpleNodes[varName] = false;
        } else if (type === 'name') {
          var reference = node[1];
          if (reference != 'undefined') {
            if (!that.affects[reference]) that.affects[reference] = {};
            if (!that.isLocal[reference]) that.dependsOnAGlobal[varName] = true;
            that.affects[reference][varName] = true;
          }
        }
      });
    }
  };

  // Updates the dependency graph (@affects) to its transitive closure && 
  // synchronizes this.dependsOnAGlobal to the new dependencies.
  this.calculateTransitiveDependencies = function() {
    var incomplete = true;
    var todo = {};
    for (var element in this.affects) {
      todo[element] = 1;
    }

    //process.stdout.write 'pre ' + JSON.stringify(@affects, null, '  ') + '\n'

    while (incomplete) {
      incomplete = false;
      var nextTodo = {};
      for (var source in this.affects) {
        var targets = this.affects[source];
        for (var target in targets) {
          if (todo[target]) {
            var this_affects_target = this.affects[target];
            for (target2 in this_affects_target) {
              if (!targets[target2]) {
                if (!this.isLocal[source]) this.dependsOnAGlobal[target2] = true;
                targets[target2] = true;
                nextTodo[source] = 1;
                incomplete = true;
              }
            }
          }
        }
      }
      todo = nextTodo;
    }

    //process.stdout.write 'post ' + JSON.stringify(@affects, null, '  ') + '\n'
  };

  // Analyzes the live ranges of single-def variables. Requires dependencies to
  // have been calculated. Fills the following member variables:
  //   depsMutatedInLiveRange
  this.analyzeLiveRanges = function() {
    var isLive = {};

    // Checks if (a given node may mutate any of the currently live variables.
    function checkForMutations(node, type) {
      var usedInThisStatement = {};
      if (type == 'assign' || type == 'call') {
        traverse(node.slice(2, 4), function(node, type) {
          if (type === 'name') usedInThisStatement[node[1]] = true;
        });
      }

      if (type == 'assign' || type == 'unary-prefix' || type == 'unary-postfix') {
        if (type === 'assign' || node[1] == '--' || node[1] == '++') {
          var reference = node[2];
          while (reference[0] != 'name') {
            reference = reference[1];
          }
          reference = reference[1];
          var aff = that.affects[reference]
          if (aff) {
            for (var varName in aff) {
              if (isLive[varName]) {
                isLive[varName] = false;
              }
            }
          }
        }
      }

      if (type in CONTROL_FLOW_NODES) {
        for (var varName in isLive) {
          if (that.dependsOnAGlobal[varName] || !usedInThisStatement[varName]) {
            isLive[varName] = false;
          }
        }
      } else if (type === 'assign') {
        for (var varName in isLive) {
          if (that.dependsOnAGlobal[varName] && !usedInThisStatement[varName]) {
            isLive[varName] = false;
          }
        }
      } else if (type === 'name') {
        var reference = node[1];
        if (that.isSingleDef[reference]) {
          if (!isLive[reference]) {
            that.depsMutatedInLiveRange[reference] = true;
          }
        }
      }
    }

    // Analyzes a block && all its children for variable ranges. Makes sure to
    // account for the worst case of possible mutations.
    function analyzeBlock(node, type) {
      if (type in ANALYZE_BLOCK_TYPES) {
        function traverseChild(child) {
          if (child && typeof child == 'object' && child.length) {
            var savedLive = {};
            for (var name in isLive) savedLive[name] = true;
            traverse(child, analyzeBlock);
            for (var name in isLive) {
              if (!isLive[name]) savedLive[name] = false;
            }
            isLive = savedLive;
          }
        }
        if (type === 'switch') {
          traverseChild(node[1]);
          var node2 = node[2];
          for (var i = 0; i < node2.length; i++) {
            traverseChild(node2[i]);
          }
        } else if (type == 'if' || type == 'try') {
          for (var i = 0; i < node.length; i++) {
            traverseChild(node[i]);
          }
        } else {
          // Don't put anything from outside into the body of a loop.
          isLive = {};
          node.forEach(traverseChild);
          // Don't keep anything alive through a loop
          isLive = {};
        }
        return node;
      }  else if (type === 'var') {
        var node1 = node[1];
        for (var i = 0; i < node1.length; i++) {
          var node1i = node1[i];
          var varName = node1i[0];
          var varValue = node1i[1];
          if (varValue) traverse(varValue, checkForMutations);
          // Mark the variable as live
          if (that.isSingleDef[varName]) {
            isLive[varName] = true;
          }
          // Mark variables that depend on it as no longer live
          if (that.affects[varName]) {
            var aff = that.affects[varName];
            for (var varNameDep in aff) {
              if (isLive[varNameDep]) {
                isLive[varNameDep] = false;
              }
            }
          }
        }
        return node;
      } else {
        checkForMutations(node, type);
      }
    }

    traverse(this.body, analyzeBlock);
  };

  // Determines whether a given variable can be safely eliminated. Requires all
  // analysis passes to have been run.
  this.isEliminateable = function(varName) {
    if (this.isSingleDef[varName] && this.usesOnlySimpleNodes[varName]) {
      if (this.useCount[varName] == 0) {
        return true;
      } else if (this.useCount[varName] <= MAX_USES) {
        return !this.depsMutatedInLiveRange[varName];
      }
    }
    return false;
  };

  // Removes all var declarations for the specified variables.
  //   this.arg toRemove: An object whose keys are the variable names to remove.
  this.removeDeclarations = function(toRemove) {
    traverse(this.body, function(node, type) {
      if (type === 'var') {
        var intactVars = node[1].filter(function(i) { return !toRemove.hasOwnProperty(i[0]) });
        if (intactVars.length) {
          node[1] = intactVars;
          return node;
        } else {
          return ['toplevel', []];
        }
      }
    });
  };

  // Updates all the values for the given variables to eliminate reference to any
  // of the other variables in the group.
  //   this.arg values: A map from variable names to their values as AST expressions.
  this.collapseValues = function(values) {
    var incomplete = true;
    while (incomplete) {
      incomplete = false;
      for (var varName in values) {
        var varValue = values[varName];
        var result = traverse(varValue, function(node, type) {
          if (type == 'name' && values.hasOwnProperty(node[1]) && node[1] != varName) {
            incomplete = true;
            return values[node[1]];
          }
        });
        if (result) values[varName] = result;
      }
    }
  };

  // Replaces all uses of the specified variables with their respective
  // expressions.
  //   this.arg replacements: A map from variable names to AST expressions.
  this.updateUses = function(replacements) {
    traverse(this.body, function(node, type) {
      if (type === 'name' && replacements.hasOwnProperty(node[1])) {
        return replacements[node[1]];
      }
    });
  };
}

// A class for optimizing expressions. We know that it === legitimate to collapse
// 5+7 in the generated code, as it will always be numerical, for example. XXX do we need this? here?
function ExpressionOptimizer(node) {
  this.node = node;

  this.run = function() {
    traverse(this.node, function(node, type) {
      if (type === 'binary' && node[1] == '+') {
        var names = [];
        var num = 0;
        var has_num = false;
        var fail = false;
        traverse(node, function(subNode, subType) {
          if (subType === 'binary') {
            if (subNode[1] != '+') {
              fail = true;
              return false;
            }
          } else if (subType === 'name') {
            names.push(subNode[1]);
            return;
          } else if (subType === 'num') {
            num += subNode[1];
            has_num = true;
            return;
          } else {
            fail = true;
            return false;
          }
        });
        if (!fail && has_num) {
          var ret = ['num', num];
          for (var i = 0; i < names.length; i++) {
            ret = ['binary', '+', ['name', names[i]], ret];
          }
          return ret;
        }
      }
    });
  };
}

// The main entry point. Reads JavaScript from stdin, runs the eliminator on each
// function, then writes the optimized result to stdout.
function main() {
  // Get the parse tree.
  //process.stderr.write(JSON.stringify(process.argv[2]) + '\n')
  var src = fs.readFileSync(process.argv[2]).toString();

  var generatedFunctionsLine = src.split('\n').filter(function(line) {
    return line.indexOf(GENERATED_FUNCTIONS_MARKER) == 0;
  });
  generatedFunctions = set(eval(generatedFunctionsLine[0].replace(GENERATED_FUNCTIONS_MARKER, '')));

  var ast = uglify.parser.parse(src);

  //process.stderr.write('1 ' + JSON.stringify(ast, null, 2) + '\n')

  // Run on all functions.
  traverse(ast, function(node, type) {
    if ((type == 'defun' || type == 'function') && isGenerated(node[1])) {
      // Run the eliminator
      //process.stderr.write (node[1] || '(anonymous)') + '\n'
      var eliminated = new Eliminator(node).run();
      // Run the expression optimizer
      new ExpressionOptimizer(node[3]).run();
    }
  });

  // Write out the optimized code.
  // NOTE: For large file, can't generate code for the whole file in a single
  //       call due to the v8 memory limit. Writing out root children instead.
  var ast1 = ast[1];
  for (var i = 0; i < ast1.length; i++) {
    var node = ast1[i];

    var js = uglify.uglify.gen_code(node, GEN_OPTIONS), old;
    // remove unneeded newlines+spaces
    do {
      old = js;
      js = js.replace(/\n *\n/g, '\n');
    } while (js != old);
    process.stdout.write(js);
    process.stdout.write('\n');
  }
  process.stdout.write(generatedFunctionsLine + '\n');
}

main();

