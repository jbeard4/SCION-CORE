//   Copyright 2011-2012 Jacob Beard, INFICON, and other SCION contributors
//
//   Licensed under the Apache License, Version 2.0 (the "License");
//   you may not use this file except in compliance with the License.
//   You may obtain a copy of the License at
//
//       http://www.apache.org/licenses/LICENSE-2.0
//
//   Unless required by applicable law or agreed to in writing, software
//   distributed under the License is distributed on an "AS IS" BASIS,
//   WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
//   See the License for the specific language governing permissions and
//   limitations under the License.

//UMD boilerplate - https://github.com/umdjs/umd/blob/master/returnExports.js
(function (root, factory) {
    if (typeof exports === 'object') {
        // Node. Does not work with strict CommonJS, but
        // only CommonJS-like enviroments that support module.exports,
        // like Node.
        module.exports = factory();
    } else if (typeof define === 'function' && define.amd) {
        // AMD. Register as an anonymous module.
        define(factory);
    } else {
        // Browser globals (root is window)
        root.scion = factory();
  }
}(this, function () {

    "use strict";

    var STATE_TYPES = {
        BASIC: 0,
        COMPOSITE: 1,
        PARALLEL: 2,
        HISTORY: 3,
        INITIAL: 4,
        FINAL: 5
    };

    var ioProcessorTypes = {
        'scxml': {
            location: 'http://www.w3.org/TR/scxml/#SCXMLEventProcessor'
        },
        'basichttp': {
            location: 'http://www.w3.org/TR/scxml/#BasicHTTPEventProcessor'
        },
        'dom': {
            location: 'http://www.w3.org/TR/scxml/#DOMEventProcessor'
        },
        'publish': {
            location: 'https://github.com/jbeard4/SCION#publish'
        }
    };

    function initializeModel(rootState){
        var transitions = [], idToStateMap = {}, documentOrder = 0;


        //TODO: need to add fake ids to anyone that doesn't have them
        //FIXME: make this safer - break into multiple passes
        var idCount = {};

        function generateId(type){
            if(idCount[type] === undefined) idCount[type] = 0;

            var count = idCount[type]++;
            return '$generated-' + type + '-' + count; 
        }

        function wrapInFakeRootState(state){
            return {
                $deserializeDatamodel : state.$deserializeDatamodel || function(){},
                $serializeDatamodel : state.$serializeDatamodel || function(){ return null;},
                $idToStateMap : idToStateMap,   //keep this for handy deserialization of serialized configuration
                states : [
                    {
                        $type : 'initial',
                        transitions : [{
                            target : state
                        }]
                    },
                    state
                ]
            };
        }

        function normalizeAction(stateOrTransition,actionProperty){
            var v = stateOrTransition[actionProperty];

            function normalize(o){
                if(typeof o === 'string'){
                    return eval(o);             //TODO: global eval
                }else if(typeof o === 'function'){
                    return o;
                }else{
                    throw new Error('Unrecognized type of object for actionProperty ' + actionProperty);
                }
            }

            if(v !== undefined) stateOrTransition[actionProperty] = Array.isArray(v) ?  v.map(normalize) : [normalize(v)];

        }

        var statesWithInitialAttributes = [];

        function traverse(ancestors,state){

            //add to global transition and state id caches
            if(state.transitions) transitions.push.apply(transitions,state.transitions);

            //populate state id map
            if(state.id){
                if(idToStateMap[state.id]) throw new Error('Redefinition of state id ' + state.id);

                idToStateMap[state.id] = state;
            }

            //create a default type, just to normalize things
            //this way we can check for unsupported types below
            state.$type = state.$type || 'state';

            //add ancestors and depth properties
            state.ancestors = ancestors;
            state.depth = ancestors.length;
            state.parent = ancestors[0];

            //add some information to transitions
            state.transitions = state.transitions || [];
            state.transitions.forEach(function(transition){
                transition.documentOrder = documentOrder++; 
                transition.source = state;
            });

            var t2 = traverse.bind(null,[state].concat(ancestors));

            //recursive step
            if(state.states) state.states.forEach(t2);

            //setup fast state type
            switch(state.$type){
                case 'parallel':
                    state.typeEnum = STATE_TYPES.PARALLEL;
                    break;
                case 'initial' : 
                    state.typeEnum = STATE_TYPES.INITIAL;
                    break;
                case 'history' :
                    state.typeEnum = STATE_TYPES.HISTORY;
                    break;
                case 'final' : 
                    state.typeEnum = STATE_TYPES.FINAL;
                    break;
                case 'state' : 
                case 'scxml' :
                    if(state.states && state.states.length){
                        state.typeEnum = STATE_TYPES.COMPOSITE;
                    }else{
                        state.typeEnum = STATE_TYPES.BASIC;
                    }
                    break;
                default :
                    throw new Error('Unknown state type: ' + state.$type);
            }

            //descendants property on states will now be populated. add descendants to this state
            if(state.states){
                state.descendants = state.states.concat(state.states.map(function(s){return s.descendants;}).reduce(function(a,b){return a.concat(b);},[]));
            }else{
                state.descendants = [];
            }

            var initialChildren;
            if(state.typeEnum === STATE_TYPES.COMPOSITE){
                //set up initial state
                
                if(typeof state.initial === 'string'){
                    statesWithInitialAttributes.push(state);
                }else{
                    //take the first child that has initial type, or first child
                    initialChildren = state.states.filter(function(child){
                        return child.$type === 'initial';
                    });

                    state.initialRef = initialChildren.length ? initialChildren[0] : state.states[0];
                    checkInitialRef(state);
                }

            }

            //hook up history
            if(state.typeEnum === STATE_TYPES.COMPOSITE ||
                    state.typeEnum === STATE_TYPES.PARALLEL){

                var historyChildren = state.states.filter(function(s){
                    return s.$type === 'history';
                }); 

               state.historyRef = historyChildren[0];
            }

            //now it's safe to fill in fake state ids
            if(!state.id){
                state.id = generateId(state.$type);
                idToStateMap[state.id] = state;
            }

            //normalize onEntry/onExit, which can be single fn or array
            ['onEntry','onExit'].forEach(normalizeAction.bind(this,state));
        }

        //TODO: convert events to regular expressions in advance

        function checkInitialRef(state){
          if(!state.initialRef) throw new Error('Unable to locate initial state for composite state: ' + state.id);
        }
        function connectIntialAttributes(){
          statesWithInitialAttributes.forEach(function(state){
            state.initialRef = idToStateMap[state.initial];
            checkInitialRef(state);
          });
        }

        function connectTransitionGraph(){
            //normalize as with onEntry/onExit
            transitions.forEach(function(t){
               normalizeAction(t,'onTransition');
            });

            transitions.forEach(function(t){
                //normalize "event" attribute into "events" attribute
                if(t.event){
                    t.events = t.event.trim().split(/ +/);
                }
            });

            //hook up targets
            transitions.forEach(function(t){
                if(t.targets || (typeof t.target === 'undefined')) return;   //targets have already been set up

                if(typeof t.target === 'string'){
                    //console.log('here1');
                    var target = idToStateMap[t.target];
                    if(!target) throw new Error('Unable to find target state with id ' + t.target);
                    t.target = target;
                    t.targets = [t.target];
                }else if(Array.isArray(t.target)){
                    //console.log('here2');
                    t.targets = t.target.map(function(target){
                        if(typeof target === 'string'){
                            target = idToStateMap[target];
                            if(!target) throw new Error('Unable to find target state with id ' + t.target);
                            return target;
                        }else{
                            return target;
                        } 
                    }); 
                }else if(typeof t.target === 'object'){
                    t.targets = [t.target];
                }else{
                    throw new Error('Transition target has unknown type: ' + t.target);
                }
            });

            //hook up LCA - optimization
            transitions.forEach(function(t){
                if(t.targets) t.lcca = getLCCA(t.source,t.targets[0]);    //FIXME: we technically do not need to hang onto the lcca. only the scope is used by the algorithm

                t.scope = getScope(t);
                //console.log('scope',t.source.id,t.scope.id,t.targets);
            });
        }

        function getScope(transition){
            //Transition scope is normally the least common compound ancestor (lcca).
            //Internal transitions have a scope equal to the source state.

            var transitionIsReallyInternal = 
                    transition.type === 'internal' &&
                        transition.source.parent &&    //root state won't have parent
                            transition.targets && //does it target its descendants
                                transition.targets.every(
                                    function(target){ return transition.source.descendants.indexOf(target) > -1;});

            if(!transition.targets){
                return transition.source; 
            }else if(transitionIsReallyInternal){
                return transition.source; 
            }else{
                return transition.lcca;
            }
        }

        function getLCCA(s1, s2) {
            //console.log('getLCCA',s1, s2);
            var commonAncestors = [];
            s1.ancestors.forEach(function(anc){
                //console.log('s1.id',s1.id,'anc',anc.id,'anc.typeEnum',anc.typeEnum,'s2.id',s2.id);
                if(anc.typeEnum === STATE_TYPES.COMPOSITE &&
                    anc.descendants.indexOf(s2) > -1){
                    commonAncestors.push(anc);
                }
            });
            //console.log('commonAncestors',s1.id,s2.id,commonAncestors.map(function(s){return s.id;}));
            if(!commonAncestors.length) throw new Error("Could not find LCA for states.");
            return commonAncestors[0];
        }

        //main execution starts here
        //FIXME: only wrap in root state if it's not a compound state
        var fakeRootState = wrapInFakeRootState(rootState);  //I wish we had pointer semantics and could make this a C-style "out argument". Instead we return him
        traverse([],fakeRootState);
        connectTransitionGraph();
        connectIntialAttributes();

        return fakeRootState;
    }

    /* begin tiny-events: https://github.com/ZauberNerd/tiny-events */
    function EventEmitter() {
        this._listeners = {};
        this._listeners['*'] = [];
    }

    EventEmitter.prototype.on = function _on(type, listener) {
        if (!Array.isArray(this._listeners[type])) {
            this._listeners[type] = [];
        }

        if (this._listeners[type].indexOf(listener) === -1) {
            this._listeners[type].push(listener);
        }

        return this;
    };

    EventEmitter.prototype.once = function _once(type, listener) {
        var self = this;

        function __once() {
            for (var args = [], i = 0; i < arguments.length; i += 1) {
                args[i] = arguments[i];
            }

            self.off(type, __once);
            listener.apply(self, args);
        }

        __once.listener = listener;

        return this.on(type, __once);
    };

    EventEmitter.prototype.off = function _off(type, listener) {
        if (!Array.isArray(this._listeners[type])) {
            return this;
        }

        if (typeof listener === 'undefined') {
            this._listeners[type] = [];
            return this;
        }

        var index = this._listeners[type].indexOf(listener);

        if (index === -1) {
            for (var i = 0; i < this._listeners[type].length; i += 1) {
                if (this._listeners[type][i].listener === listener) {
                    index = i;
                    break;
                }
            }
        }

        this._listeners[type].splice(index, 1);
        return this;
    };

    EventEmitter.prototype.emit = function _emit(type) {

        var args = Array.prototype.slice.call(arguments);
        var modifiedArgs = args.slice(1);

        if (Array.isArray(this._listeners[type])) {
          this._listeners[type].forEach(function __emit(listener) {
              listener.apply(this, modifiedArgs);
          }, this);
        }

        //special '*' event
        this._listeners['*'].forEach(function __emit(listener) {
            listener.apply(this, args);
        }, this);

        return this;
    };

    /* end tiny-events */

    /* begin ArraySet */

    /** @constructor */
    function ArraySet(l) {
        l = l || [];
        this.o = [];
            
        l.forEach(function(x){
            this.add(x);
        },this);
    }

    ArraySet.prototype = {

        add : function(x) {
            if (!this.contains(x)) return this.o.push(x);
        },

        remove : function(x) {
            var i = this.o.indexOf(x);
            if(i === -1){
                return false;
            }else{
                this.o.splice(i, 1);
            }
            return true;
        },

        union : function(l) {
            l = l.iter ? l.iter() : l;
            l.forEach(function(x){
                this.add(x);
            },this);
            return this;
        },

        difference : function(l) {
            l = l.iter ? l.iter() : l;

            l.forEach(function(x){
                this.remove(x);
            },this);
            return this;
        },

        contains : function(x) {
            return this.o.indexOf(x) > -1;
        },

        iter : function() {
            return this.o;
        },

        isEmpty : function() {
            return !this.o.length;
        },

        equals : function(s2) {
            var l2 = s2.iter();
            var l1 = this.o;

            return l1.every(function(x){
                return l2.indexOf(x) > -1;
            }) && l2.every(function(x){
                return l1.indexOf(x) > -1;
            });
        },

        toString : function() {
            return "Set(" + this.o.toString() + ")";
        }
    };

    function eventlessTransitionSelector(state){
      return state.transitions.filter(function(transition){ return !transition.event; });
    }

    var scxmlPrefixTransitionSelector = (function(){

        var eventNameReCache = {};

        function eventNameToRe(name) {
            return new RegExp("^" + (name.replace(/\./g, "\\.")) + "(\\.[0-9a-zA-Z]+)*$");
        }

        function retrieveEventRe(name) {
            return eventNameReCache[name] ? eventNameReCache[name] : eventNameReCache[name] = eventNameToRe(name);
        }

        function nameMatch(t, event) {
            return event && event.name &&
                        (t.events.indexOf("*") > -1 ? 
                            true : 
                                t.events.filter(function(tEvent){
                                    return retrieveEventRe(tEvent).test(event.name);
                                }).length);

        }

        return function(state, event, evaluator) {
            return state.transitions.filter(function(t){
                return (!t.events || nameMatch(t,event)) && (!t.cond || evaluator(t.cond));
            });
        };
    })();

    //model accessor functions
    var query = {
        getAncestors: function(s, root) {
            var ancestors, index, state;
            index = s.ancestors.indexOf(root);
            if (index > -1) {
                return s.ancestors.slice(0, index);
            } else {
                return s.ancestors;
            }
        },
        /** @this {model} */
        getAncestorsOrSelf: function(s, root) {
            return [s].concat(this.getAncestors(s, root));
        },
        getDescendantsOrSelf: function(s) {
            return [s].concat(s.descendants);
        },
        /** @this {model} */
        isOrthogonalTo: function(s1, s2) {
            //Two control states are orthogonal if they are not ancestrally
            //related, and their smallest, mutual parent is a Concurrent-state.
            return !this.isAncestrallyRelatedTo(s1, s2) && this.getLCA(s1, s2).typeEnum === STATE_TYPES.PARALLEL;
        },
        /** @this {model} */
        isAncestrallyRelatedTo: function(s1, s2) {
            //Two control states are ancestrally related if one is child/grandchild of another.
            return this.getAncestorsOrSelf(s2).indexOf(s1) > -1 || this.getAncestorsOrSelf(s1).indexOf(s2) > -1;
        },
        /** @this {model} */
        getLCA: function(s1, s2) {
            var commonAncestors = this.getAncestors(s1).filter(function(a){
                return a.descendants.indexOf(s2) > -1;
            },this);
            return commonAncestors[0];
        }
    };
    
    //priority comparison functions
    function getTransitionWithHigherSourceChildPriority(_arg) {
        var t1 = _arg[0], t2 = _arg[1];
        //compare transitions based first on depth, then based on document order

        if (t1.source.depth < t2.source.depth) {
            return t2;
        } else if (t2.source.depth < t1.source.depth) {
            return t1;
        } else {
            if (t1.documentOrder < t2.documentOrder) {
                return t1;
            } else {
                return t2;
            }
        }
    }

    function initializeModelGeneratorFn(modelFn, opts, interpreter){

         opts.x =  opts.x || {};

        var args = ['x','sessionid','ioprocessors'].
                            map(function(name){ return opts.x['_' + name] = opts[name]; }).
                                concat(interpreter.isIn.bind(interpreter));

        //the "model" might be a function, so we lazy-init him here to get the root state
        return modelFn.apply(interpreter,args);
    }

    function deserializeSerializedConfiguration(serializedConfiguration,idToStateMap){
      return serializedConfiguration.map(function(id){
        var state = idToStateMap[id];
        if(!state) throw new Error('Error loading serialized configuration. Unable to locate state with id ' + id);
        return state;
      });
    }

    function deserializeHistory(serializedHistory,idToStateMap){
      var o = {};
      Object.keys(serializedHistory).forEach(function(sid){
        o[sid] = serializedHistory[sid].map(function(id){
          var state = idToStateMap[id];
          if(!state) throw new Error('Error loading serialized history. Unable to locate state with id ' + id);
          return state;
        });
      });
      return o;
    }
 
    /** @const */
    var printTrace = false;

    /** @constructor */
    function BaseInterpreter(modelOrFnGenerator, opts){

        EventEmitter.call(this);

        this._scriptingContext = opts.interpreterScriptingContext || (opts.InterpreterScriptingContext ? new opts.InterpreterScriptingContext(this) : {}); 

        var model;
        if(typeof modelOrFnGenerator === 'function'){
            model = initializeModelGeneratorFn(modelOrFnGenerator, opts, this);
        }else if(typeof modelOrFnGenerator === 'string'){
            model = JSON.parse(modelOrFnGenerator);
        }else{
            model = modelOrFnGenerator;
        }

        this._model = initializeModel(model);

        //console.log(require('util').inspect(this._model,false,4));
       
        this.opts = opts || {};

        this.opts.console = opts.console || (typeof console === 'undefined' ? {log : function(){}} : console);   //rely on global console if this console is undefined
        this.opts.Set = this.opts.Set || ArraySet;
        this.opts.priorityComparisonFn = this.opts.priorityComparisonFn || getTransitionWithHigherSourceChildPriority;
        this.opts.transitionSelector = this.opts.transitionSelector || scxmlPrefixTransitionSelector;

        this._scriptingContext.log = this._scriptingContext.log || this.opts.console.log;   //set up default scripting context log function

        this._internalEventQueue = [];

        //check if we're loading from a previous snapshot
        if(opts.snapshot){
          this._configuration = new this.opts.Set(deserializeSerializedConfiguration(opts.snapshot[0], this._model.$idToStateMap));
          this._historyValue = deserializeHistory(opts.snapshot[1], this._model.$idToStateMap); 
          this._isInFinalState = opts.snapshot[2];
          this._model.$deserializeDatamodel(opts.snapshot[3]);   //load up the datamodel
        }else{
          this._configuration = new this.opts.Set();
          this._historyValue = {};
          this._isInFinalState = false;
        }

        //SCXML system variables:
        this._x = {
            _sessionId : opts.sessionId || null,
            _name : model.name || opts.name || null,
            _ioprocessors : opts.ioprocessors || null
        };

    }

    BaseInterpreter.prototype = extend(beget(EventEmitter.prototype),{

        /** @expose */
        start : function() {
            //perform big step without events to take all default transitions and reach stable initial state
            if (printTrace) this.opts.console.log("performing initial big step");

            //We effectively need to figure out states to enter here to populate initial config. assuming root is compound state makes this simple.
            //but if we want it to be parallel, then this becomes more complex. so when initializing the model, we add a 'fake' root state, which
            //makes the following operation safe.
            this._configuration.add(this._model.initialRef);   

            this._performBigStep();
            return this.getConfiguration();
        },

        /** @expose */
        getConfiguration : function() {
            return this._configuration.iter().map(function(s){return s.id;});
        },

        /** @expose */
        getFullConfiguration : function() {
            return this._configuration.iter().
                    map(function(s){ return [s].concat(query.getAncestors(s));},this).
                    reduce(function(a,b){return a.concat(b);},[]).    //flatten
                    map(function(s){return s.id;}).
                    reduce(function(a,b){return a.indexOf(b) > -1 ? a : a.concat(b);},[]); //uniq
        },


        /** @expose */
        isIn : function(stateName) {
            return this.getFullConfiguration().indexOf(stateName) > -1;
        },

        /** @expose */
        isFinal : function(stateName) {
            return this._isInFinalState;
        },

        /** @private */
        _performBigStep : function(e) {
            if (e) this._internalEventQueue.push(e);
            var keepGoing = true;
            while (keepGoing) {
                var selectedTransitions  = this._selectTransitions(currentEvent, true);
                if(selectedTransitions.isEmpty()){
                  var currentEvent = this._internalEventQueue.shift() || null;
                  selectedTransitions = this._selectTransitions(currentEvent, false);
                }
                this._performSmallStep(currentEvent, selectedTransitions);
                keepGoing = !selectedTransitions.isEmpty();
            }
            this._isInFinalState = this._configuration.iter().every(function(s){ return s.typeEnum === STATE_TYPES.FINAL; });
        },

        /** @private */
        _performSmallStep : function(currentEvent, selectedTransitions) {

            if (printTrace) this.opts.console.log("selected transitions: ", selectedTransitions);

            if (!selectedTransitions.isEmpty()) {

                if (printTrace) this.opts.console.log("sorted transitions: ", selectedTransitions);

                //we only want to enter and exit states from transitions with targets
                //filter out targetless transitions here - we will only use these to execute transition actions
                var selectedTransitionsWithTargets = new this.opts.Set(selectedTransitions.iter().filter(function(t){return t.targets;}));

                var exitedTuple = this._getStatesExited(selectedTransitionsWithTargets), 
                    basicStatesExited = exitedTuple[0], 
                    statesExited = exitedTuple[1];

                var enteredTuple = this._getStatesEntered(selectedTransitionsWithTargets), 
                    basicStatesEntered = enteredTuple[0], 
                    statesEntered = enteredTuple[1];

                if (printTrace) this.opts.console.log("basicStatesExited ", basicStatesExited);
                if (printTrace) this.opts.console.log("basicStatesEntered ", basicStatesEntered);
                if (printTrace) this.opts.console.log("statesExited ", statesExited);
                if (printTrace) this.opts.console.log("statesEntered ", statesEntered);

                var eventsToAddToInnerQueue = new this.opts.Set();

                //update history states
                if (printTrace) this.opts.console.log("executing state exit actions");

                var evaluateAction = this._evaluateAction.bind(this, currentEvent);        //create helper fn that actions can call later on

                statesExited.forEach(function(state){

                    if (printTrace || this.opts.logStatesEnteredAndExited) this.opts.console.log("exiting ", state.id);

                    //invoke listeners
                    this.emit('onExit',state.id)

                    if(state.onExit !== undefined) state.onExit.forEach(evaluateAction);

                    var f;
                    if (state.historyRef) {
                        if (state.historyRef.isDeep) {
                            f = function(s0) {
                                return s0.typeEnum === STATE_TYPES.BASIC && state.descendants.indexOf(s0) > -1;
                            };
                        } else {
                            f = function(s0) {
                                return s0.parent === state;
                            };
                        }
                        //update history
                        this._historyValue[state.historyRef.id] = statesExited.filter(f);
                    }
                },this);


                // -> Concurrency: Number of transitions: Multiple
                // -> Concurrency: Order of transitions: Explicitly defined
                var sortedTransitions = selectedTransitions.iter().sort(function(t1, t2) {
                    return t1.documentOrder - t2.documentOrder;
                });

                if (printTrace) this.opts.console.log("executing transitition actions");


                sortedTransitions.forEach(function(transition){

                    var targetIds = transition.targets && transition.targets.map(function(target){return target.id;});

                    this.emit('onTransition',transition.source.id,targetIds);

                    if(transition.onTransition !== undefined) transition.onTransition.forEach(evaluateAction);
                },this);
     
                if (printTrace) this.opts.console.log("executing state enter actions");

                statesEntered.forEach(function(state){

                    if (printTrace || this.opts.logStatesEnteredAndExited) this.opts.console.log("entering", state.id);

                    this.emit('onEntry',state.id);

                    if(state.onEntry !== undefined) state.onEntry.forEach(evaluateAction);
                },this);

                if (printTrace) this.opts.console.log("updating configuration ");
                if (printTrace) this.opts.console.log("old configuration ", this._configuration);

                //update configuration by removing basic states exited, and adding basic states entered
                this._configuration.difference(basicStatesExited);
                this._configuration.union(basicStatesEntered);


                if (printTrace) this.opts.console.log("new configuration ", this._configuration);
                
                //add set of generated events to the innerEventQueue -> Event Lifelines: Next small-step
                if (!eventsToAddToInnerQueue.isEmpty()) {
                    if (printTrace) this.opts.console.log("adding triggered events to inner queue ", eventsToAddToInnerQueue);
                    this._internalEventQueue.push(eventsToAddToInnerQueue);
                }

            }

            //if selectedTransitions is empty, we have reached a stable state, and the big-step will stop, otherwise will continue -> Maximality: Take-Many
            return selectedTransitions;
        },

        /** @private */
        _evaluateAction : function(currentEvent, actionRef) {
            try {
              return actionRef.call(this._scriptingContext, currentEvent);     //SCXML system variables
            } catch (e){
              var err = {
                tagname: actionRef.tagname, 
                line: actionRef.line, 
                column: actionRef.column,
                reason: e.message
              }
              this._internalEventQueue.push({"name":"error.execution",data : err});
              this.emit('onError', err);
            }
        },

        /** @private */
        _getStatesExited : function(transitions) {
            var statesExited = new this.opts.Set();
            var basicStatesExited = new this.opts.Set();

            //States exited are defined to be active states that are
            //descendants of the scope of each priority-enabled transition.
            //Here, we iterate through the transitions, and collect states
            //that match this condition. 
            transitions.iter().forEach(function(transition){
                var scope = transition.scope,
                    desc = scope.descendants;

                //For each state in the configuration
                //is that state a descendant of the transition scope?
                //Store ancestors of that state up to but not including the scope.
                this._configuration.iter().forEach(function(state){
                    if(desc.indexOf(state) > -1){
                        basicStatesExited.add(state);
                        statesExited.add(state);
                        query.getAncestors(state,scope).forEach(function(anc){
                            statesExited.add(anc);
                        });
                    }
                },this);
            },this);

            var sortedStatesExited = statesExited.iter().sort(function(s1, s2) {
                return s2.depth - s1.depth;
            });
            return [basicStatesExited, sortedStatesExited];
        },

        /** @private */
        _getStatesEntered : function(transitions) {

            var o = {
                statesToEnter : new this.opts.Set(),
                basicStatesToEnter : new this.opts.Set(),
                statesProcessed  : new this.opts.Set(),
                statesToProcess : []
            };

            //do the initial setup
            transitions.iter().forEach(function(transition){
                transition.targets.forEach(function(target){
                    this._addStateAndAncestors(target,transition.scope,o);
                },this);
            },this);

            //loop and add states until there are no more to add (we reach a stable state)
            var s;
            /*jsl:ignore*/
            while(s = o.statesToProcess.pop()){
                /*jsl:end*/
                this._addStateAndDescendants(s,o);
            }

            //sort based on depth
            var sortedStatesEntered = o.statesToEnter.iter().sort(function(s1, s2) {
                return s1.depth - s2.depth;
            });

            return [o.basicStatesToEnter, sortedStatesEntered];
        },

        /** @private */
        _addStateAndAncestors : function(target,scope,o){

            //process each target
            this._addStateAndDescendants(target,o);

            //and process ancestors of targets up to the scope, but according to special rules
            query.getAncestors(target,scope).forEach(function(s){

                if (s.typeEnum === STATE_TYPES.COMPOSITE) {
                    //just add him to statesToEnter, and declare him processed
                    //this is to prevent adding his initial state later on
                    o.statesToEnter.add(s);

                    o.statesProcessed.add(s);
                }else{
                    //everything else can just be passed through as normal
                    this._addStateAndDescendants(s,o);
                } 
            },this);
        },

        /** @private */
        _addStateAndDescendants : function(s,o){

            if(o.statesProcessed.contains(s)) return;

            if (s.typeEnum === STATE_TYPES.HISTORY) {
                if (s.id in this._historyValue) {
                    this._historyValue[s.id].forEach(function(stateFromHistory){
                        this._addStateAndAncestors(stateFromHistory,s.parent,o);
                    },this);
                } else {
                    o.statesToEnter.add(s);
                    o.basicStatesToEnter.add(s);
                }
            } else {
                o.statesToEnter.add(s);

                if (s.typeEnum === STATE_TYPES.PARALLEL) {
                    o.statesToProcess.push.apply(o.statesToProcess,
                        s.states.filter(function(s){return s.typeEnum !== STATE_TYPES.HISTORY;}));
                } else if (s.typeEnum === STATE_TYPES.COMPOSITE) {
                    o.statesToProcess.push(s.initialRef); 
                } else if (s.typeEnum === STATE_TYPES.INITIAL || s.typeEnum === STATE_TYPES.BASIC || s.typeEnum === STATE_TYPES.FINAL) {
                    o.basicStatesToEnter.add(s);
                }
            }

            o.statesProcessed.add(s); 
        },

        /** @private */
        _selectTransitions : function(currentEvent, selectEventlessTransitions) {
            if (this.opts.onlySelectFromBasicStates) {
                var states = this._configuration.iter();
            } else {
                var statesAndParents = new this.opts.Set;

                //get full configuration, unordered
                //this means we may select transitions from parents before states
                
                this._configuration.iter().forEach(function(basicState){
                    statesAndParents.add(basicState);
                    query.getAncestors(basicState).forEach(function(ancestor){
                        statesAndParents.add(ancestor);
                    });
                },this);

                states = statesAndParents.iter();
            }

            var transitionSelector = selectEventlessTransitions ? eventlessTransitionSelector : scxmlPrefixTransitionSelector;

            var enabledTransitions = new this.opts.Set();

            var e = this._evaluateAction.bind(this,currentEvent);

            states.forEach(function(state){
                transitionSelector(state,currentEvent,e).forEach(function(t){
                    enabledTransitions.add(t);
                });
            });

            var priorityEnabledTransitions = this._selectPriorityEnabledTransitions(enabledTransitions);

            if (printTrace) this.opts.console.log("priorityEnabledTransitions", priorityEnabledTransitions);
            
            return priorityEnabledTransitions;
        },

        /** @private */
        _selectPriorityEnabledTransitions : function(enabledTransitions) {
            var priorityEnabledTransitions = new this.opts.Set();

            var tuple = this._getInconsistentTransitions(enabledTransitions), 
                consistentTransitions = tuple[0], 
                inconsistentTransitionsPairs = tuple[1];

            priorityEnabledTransitions.union(consistentTransitions);

            if (printTrace) this.opts.console.log("enabledTransitions", enabledTransitions);
            if (printTrace) this.opts.console.log("consistentTransitions", consistentTransitions);
            if (printTrace) this.opts.console.log("inconsistentTransitionsPairs", inconsistentTransitionsPairs);
            if (printTrace) this.opts.console.log("priorityEnabledTransitions", priorityEnabledTransitions);
            
            while (!inconsistentTransitionsPairs.isEmpty()) {
                enabledTransitions = new this.opts.Set(
                        inconsistentTransitionsPairs.iter().map(function(t){return this.opts.priorityComparisonFn(t);},this));

                tuple = this._getInconsistentTransitions(enabledTransitions);
                consistentTransitions = tuple[0]; 
                inconsistentTransitionsPairs = tuple[1];

                priorityEnabledTransitions.union(consistentTransitions);

                if (printTrace) this.opts.console.log("enabledTransitions", enabledTransitions);
                if (printTrace) this.opts.console.log("consistentTransitions", consistentTransitions);
                if (printTrace) this.opts.console.log("inconsistentTransitionsPairs", inconsistentTransitionsPairs);
                if (printTrace) this.opts.console.log("priorityEnabledTransitions", priorityEnabledTransitions);
                
            }
            return priorityEnabledTransitions;
        },

        /** @private */
        _getInconsistentTransitions : function(transitions) {
            var allInconsistentTransitions = new this.opts.Set();
            var inconsistentTransitionsPairs = new this.opts.Set();
            var transitionList = transitions.iter();

            if (printTrace) this.opts.console.log("transitions", transitionList);

            for(var i = 0; i < transitionList.length; i++){
                for(var j = i+1; j < transitionList.length; j++){
                    var t1 = transitionList[i];
                    var t2 = transitionList[j];
                    if (this._conflicts(t1, t2)) {
                        allInconsistentTransitions.add(t1);
                        allInconsistentTransitions.add(t2);
                        inconsistentTransitionsPairs.add([t1, t2]);
                    }
                }
            }

            var consistentTransitions = transitions.difference(allInconsistentTransitions);
            return [consistentTransitions, inconsistentTransitionsPairs];
        },

        /** @private */
        _conflicts : function(t1, t2) {
            return !this._isArenaOrthogonal(t1, t2);
        },

        /** @private */
        _isArenaOrthogonal : function(t1, t2) {

            if (printTrace) this.opts.console.log("transition scopes", t1.scope, t2.scope);

            var isOrthogonal = query.isOrthogonalTo(t1.scope, t2.scope);

            if (printTrace) this.opts.console.log("transition scopes are orthogonal?", isOrthogonal);

            return isOrthogonal;
        },


        /*
            registerListener provides a generic mechanism to subscribe to state change and runtime error notifications.
            Can be used for logging and debugging. For example, can attach a logger that simply logs the state changes.
            Or can attach a network debugging client that sends state change notifications to a debugging server.
        
            listener is of the form:
            {
              onEntry : function(stateId){},
              onExit : function(stateId){},
              onTransition : function(sourceStateId,targetStatesIds[]){},
              onError: function(errorInfo){}
            }
        */
        //TODO: refactor this to be event emitter? 

        /** @expose */
        registerListener : function(listener){
            if(listener.onEntry) this.on('onEntry',listener.onEntry);
            if(listener.onExit) this.on('onExit',listener.onExit);
            if(listener.onTransition) this.on('onTransition',listener.onTransition);
            if(listener.onError) this.on('onError', listener.onError);
        },

        /** @expose */
        unregisterListener : function(listener){
            if(listener.onEntry) this.off('onEntry',listener.onEntry);
            if(listener.onExit) this.off('onExit',listener.onExit);
            if(listener.onTransition) this.off('onTransition',listener.onTransition);
            if(listener.onError) this.off('onError', listener.onError);
        },

        /** @expose */
        getAllTransitionEvents : function(){
            var events = {};
            function getEvents(state){

                if(state.transitions){
                    state.transitions.forEach(function(transition){
                        events[transition.event] = true;
                    });
                }

                if(state.states) state.states.forEach(getEvents);
            }
            getEvents(this._model);

            return Object.keys(events);
        },

        
        /** @expose */
        /**
          Three things capture the current snapshot of a running SCION interpreter:

          * basic configuration (the set of basic states the state machine is in)
          * history state values (the states the state machine was in last time it was in the parent of a history state)
          * the datamodel
          
          Note that this assumes that the method to serialize a scion.SCXML
          instance is not called when the interpreter is executing a big-step (e.g. after
          scion.SCXML.prototype.gen is called, and before the call to gen returns). If
          the serialization method is called during the execution of a big-step, then the
          inner event queue must also be saved. I do not expect this to be a common
          requirement however, and therefore I believe it would be better to only support
          serialization when the interpreter is not executing a big-step.
        */
        getSnapshot : function(){
          if(this._isStepping) throw new Error('getSnapshot cannot be called while interpreter is executing a big-step');


          return [
            this.getConfiguration(),
            this._serializeHistory(),
            this._isInFinalState,
            this._model.$serializeDatamodel()
          ];
        },

        _serializeHistory : function(){
          var o = {};
          Object.keys(this._historyValue).forEach(function(sid){
            o[sid] = this._historyValue[sid].map(function(state){return state.id});
          },this);
          return o;
        }
    });

    /**
     * @constructor
     * @extends BaseInterpreter
     */
    function Statechart(model, opts) {
        opts = opts || {};

        opts.ioprocessors = {};

        //Create all supported Event I/O processor nodes.
        //TODO fix location after implementing actual processors
        Object.keys(ioProcessorTypes).forEach(function(processor){
            opts.ioprocessors[processor] = ioProcessorTypes[processor];
        });

        opts.InterpreterScriptingContext = opts.InterpreterScriptingContext || InterpreterScriptingContext;

        this._isStepping = false;

        BaseInterpreter.call(this,model,opts);     //call super constructor
    }

    function beget(o){
        function F(){}
        F.prototype = o;
        return new F();
    }

    function extend(to, from){
      Object.keys(from).forEach(function(k){
        to[k] = from[k]; 
      });
      return to;
    }

    //Statechart.prototype = Object.create(BaseInterpreter.prototype);
    //would like to use Object.create here, but not portable, but it's too complicated to use portably
    Statechart.prototype = beget(BaseInterpreter.prototype);    

    /** @expose */
    Statechart.prototype.gen = function(evtObjOrName,optionalData) {

        var currentEvent;
        switch(typeof evtObjOrName){
            case 'string':
                currentEvent = {name : evtObjOrName, data : optionalData};
                break;
            case 'object':
                if(typeof evtObjOrName.name === 'string'){
                    currentEvent = evtObjOrName;
                }else{
                    throw new Error('Event object must have "name" property of type string.');
                }
                break;
            default:
                throw new Error('First argument to gen must be a string or object.');
        }

        if(this._isStepping) throw new Error('Cannot call gen during a big-step');

        //otherwise, kick him off
        this._isStepping = true;

        this._performBigStep(currentEvent);

        this._isStepping = false;
        return this.getConfiguration();
    };

    function InterpreterScriptingContext(interpreter) {
        this._interpreter = interpreter;
        this._timeoutMap = {};
    }

    //Regex from:
    //  http://daringfireball.net/2010/07/improved_regex_for_matching_urls
    //  http://stackoverflow.com/a/6927878
    var validateUriRegex = /\b((?:[a-z][\w-]+:(?:\/{1,3}|[a-z0-9%])|www\d{0,3}[.]|[a-z0-9.\-]+[.][a-z]{2,4}\/)(?:[^\s()<>]+|\(([^\s()<>]+|(\([^\s()<>]+\)))*\))+(?:\(([^\s()<>]+|(\([^\s()<>]+\)))*\)|[^\s`!()\[\]{};:'".,<>?«»“”‘’]))/i;

    //TODO: consider whether this is the API we would like to expose
    InterpreterScriptingContext.prototype = {
        raise : function(event){
            this._interpreter._internalEventQueue.push(event); 
        },
        send : function(event, options){
            //TODO: move these out
            function validateSend(event, options, sendAction){
              if(event.target){
                var targetIsValidUri = validateUriRegex.test(event.target)
                if(!targetIsValidUri){
                  return this.raise({ name : "error.execution", data: 'Target is not valid URI', sendid: options.sendid });
                }
              }

              var eventProcessorTypes = Object.keys(ioProcessorTypes).map(function(k){return ioProcessorTypes[k].location});
              if(eventProcessorTypes.indexOf(event.type) === -1) {
                  return this.raise({ name : "error.execution", data: 'Unsupported event processor type', sendid: options.sendid });
              }

              sendAction.call(this, event, options);
            }

            function defaultSendAction (event, options) {

              if( typeof setTimeout === 'undefined' ) throw new Error('Default implementation of Statechart.prototype.send will not work unless setTimeout is defined globally.');

              var timeoutId = setTimeout(this._interpreter.gen.bind(this._interpreter, event), options.delay || 0);

              if (options.sendid) this._timeoutMap[options.sendid] = timeoutId;
            }

            function publish(){
              this._interpreter.emit(event.name,event.data);
            }

            event.type = event.type || ioProcessorTypes.scxml.location;

            //choose send function
            var sendFn;
            if(event.type === 'https://github.com/jbeard4/SCION#publish'){
              sendFn = publish;
            }else if(this._interpreter.opts.customSend){
              sendFn = this._interpreter.opts.customSend;
            }else{
              sendFn = defaultSendAction;
            }

            options=options || {};

            if (printTrace) this._interpreter.opts.console.log("sending event", event.name, "with content", event.data, "after delay", options.delay);

            validateSend.call(this, event, options, sendFn);
        },
        cancel : function(sendid){
            if(this._interpreter.opts.customCancel) {
                return this._interpreter.opts.customCancel.apply(this, [sendid]);
            }

            if( typeof clearTimeout === 'undefined' ) throw new Error('Default implementation of Statechart.prototype.cancel will not work unless setTimeout is defined globally.');

            if (sendid in this._timeoutMap) {
                if (printTrace) this._interpreter.opts.console.log("cancelling ", sendid, " with timeout id ", this._timeoutMap[sendid]);
                clearTimeout(this._timeoutMap[sendid]);
            }
        }
    };

    return {
        /** @expose */
        BaseInterpreter: BaseInterpreter,
        /** @expose */
        Statechart: Statechart,
        /** @expose */
        ArraySet : ArraySet,
        /** @expose */
        STATE_TYPES : STATE_TYPES,
        /** @expose */
        initializeModel : initializeModel,
        /** @expose */
        InterpreterScriptingContext : InterpreterScriptingContext,
        /** @expose */
        ioProcessorTypes  : ioProcessorTypes 
    };
}));
