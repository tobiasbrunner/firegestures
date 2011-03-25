////////////////////////////////////////////////////////////////
// global

const Cc = Components.classes;
const Ci = Components.interfaces;

const PREFS_DOMAIN = "extensions.firegestures.";
const HTML_NS = "http://www.w3.org/1999/xhtml";

const STATE_READY    = 0;
const STATE_GESTURE  = 1;
const STATE_ROCKER   = 2;
const STATE_WHEEL    = 3;
const STATE_KEYPRESS = 4;

Components.utils.import("resource://gre/modules/XPCOMUtils.jsm");

// #debug-begin
function log(aMsg) {
	dump("GestureHandler> " + aMsg + "\n");
}

function alert(aMsg) {
	Components.utils.reportError(aMsg);
	var fuelApp = Cc["@mozilla.org/fuel/application;1"].getService(Ci.fuelIApplication);
	fuelApp.console.open();
}

const PLATFORM = Cc["@mozilla.org/system-info;1"].getService(Ci.nsIPropertyBag2).getProperty("name");
// #debug-end


////////////////////////////////////////////////////////////////
// xdGestureHandler

function xdGestureHandler() {}


xdGestureHandler.prototype = {

	// XPCOM registration info
	classDescription: "Mouse Gesture Handler",
	contractID: "@xuldev.org/firegestures/handler;1",
	classID: Components.ID("{ca559550-8ab4-41c5-a72f-fd931322cc7e}"),
	QueryInterface: XPCOMUtils.generateQI([
		Ci.nsISupports,
		Ci.nsIObserver,
		Ci.nsISupportsWeakReference,
		Ci.nsIDOMEventListener,
		Ci.nsITimerCallback,
		Ci.xdIGestureHandler
	]),

	// DOM element at the starting point of gesture
	sourceNode: null,

	// DOM element where user can perform gesture
	_drawArea: null,

	// last position of an on-screen mouse pointer
	_lastX: null,
	_lastY: null,

	// current direction chain e.g. LRLRUDUD
	_directionChain: "",

	// xdIGestureObserver
	_gestureObserver: null,

	// [Firefox4]
	_isFx4: false,

	attach: function FGH_attach(aDrawArea, aObserver) {
		var appInfo = Cc["@mozilla.org/xre/app-info;1"].getService(Ci.nsIXULAppInfo);
		this._isFx4 = parseFloat(appInfo.version) >= 4.0;
		this._drawArea = aDrawArea;
		this._gestureObserver = aObserver;
		this._drawArea.addEventListener("mousedown", this, true);
		if (this._isFx4) {
			var root = this._drawArea.ownerDocument.defaultView.document.documentElement;
			root.addEventListener("mousemove", this, true);
			root.addEventListener("mouseup", this, true);
		}
		else {
			this._drawArea.addEventListener("mousemove", this, true);
			this._drawArea.addEventListener("mouseup", this, true);
		}
		this._drawArea.addEventListener("contextmenu", this, true);
		this._drawArea.addEventListener("draggesture", this, true);
		this._reloadPrefs();
		var prefBranch2 = Cc["@mozilla.org/preferences-service;1"].getService(Ci.nsIPrefBranch2);
		prefBranch2.addObserver(PREFS_DOMAIN, this, true);
		// log("attach(" + aDrawArea + ", " + aObserver + ")");	// #debug
	},

	detach: function FGH_detach() {
		this._drawArea.removeEventListener("mousedown", this, true);
		if (this._isFx4) {
			var root = this._drawArea.ownerDocument.defaultView.document.documentElement;
			root.removeEventListener("mousemove", this, true);
			root.removeEventListener("mouseup", this, true);
		}
		else {
			this._drawArea.removeEventListener("mousemove", this, true);
			this._drawArea.removeEventListener("mouseup", this, true);
		}
		this._drawArea.removeEventListener("contextmenu", this, true);
		this._drawArea.removeEventListener("draggesture", this, true);
		var prefBranch2 = Cc["@mozilla.org/preferences-service;1"].getService(Ci.nsIPrefBranch2);
		prefBranch2.removeObserver(PREFS_DOMAIN, this);
		this._clearTimeout();
		this.sourceNode = null;
		this._drawArea = null;
		this._gestureObserver = null;
		this._prefs = null;
		// log("detach()");	// #debug
	},

	// called from init, observe
	_reloadPrefs: function FGH__reloadPrefs() {
		var prefBranch = Cc["@mozilla.org/preferences-service;1"]
		                 .getService(Ci.nsIPrefService)
		                 .getBranch(PREFS_DOMAIN);
		// @see nsSessionStore.js
		var getPref = function(aName) {
			try {
				switch (prefBranch.getPrefType(aName)) {
					case prefBranch.PREF_STRING:
						return prefBranch.getCharPref(aName);
					case prefBranch.PREF_BOOL:
						return prefBranch.getBoolPref(aName);
					case prefBranch.PREF_INT:
						return prefBranch.getIntPref(aName);
					default:
						throw null;
				}
			}
			catch(ex) {
				alert("Assertion failed!\ngetPref(" + aName + ")\n" + ex);	// #debug
			}
		};
		this._triggerButton  = getPref("trigger_button");
		this._suppressAlt    = getPref("suppress.alt");
		this._trailEnabled   = getPref("mousetrail");
		this._trailSize      = getPref("mousetrail.size");
		this._trailColor     = getPref("mousetrail.color");
		this._gestureTimeout = getPref("gesture_timeout");
		this._mouseGestureEnabled        = getPref("mousegesture");
		this._wheelGestureEnabled        = getPref("wheelgesture");
		this._rockerGestureEnabled       = getPref("rockergesture");
		this._rockerGestureMiddleEnabled = getPref("rockergesture.middle");
		this._keypressGestureEnabled     = getPref("keypressgesture");
		// prefs for wheel gestures and rocker gestures
		this._drawArea.removeEventListener("DOMMouseScroll", this, true);
		this._drawArea.removeEventListener("click", this, true);
		if (this._wheelGestureEnabled)
			this._drawArea.addEventListener("DOMMouseScroll", this, true);
		if (this._rockerGestureEnabled || this._rockerGestureMiddleEnabled)
			this._drawArea.addEventListener("click", this, true);
		// prefs for tab wheel gesture
		var tabbrowser = this._drawArea.ownerDocument.getBindingParent(this._drawArea);
		if (tabbrowser && tabbrowser.localName == "tabbrowser") {
			tabbrowser.mStrip.removeEventListener("DOMMouseScroll", this._wheelOnTabBar, true);
			if (getPref("tabwheelgesture"))
				tabbrowser.mStrip.addEventListener("DOMMouseScroll", this._wheelOnTabBar, true);
		}
		var prefSvc = Cc["@mozilla.org/preferences-service;1"]
              .getService(Ci.nsIPrefBranch2)
              .QueryInterface(Ci.nsIPrefService);
		// if rocker gestures involving the middle mouse button are enabled, disable autoscroll
		if (this._rockerGestureMiddleEnabled) {
			prefSvc.setBoolPref("general.autoScroll", false);
		}
		// if trigger button is middle, disable loading the clipboard URL with middle click.
		if (this._triggerButton == 1) {
			prefSvc.setBoolPref("middlemouse.contentLoadURL", false);
			// alert("middlemouse.contentLoadURL has been changed.");	// #debug
		}
		// log("_reloadPrefs " + this._prefs.toSource());	// #debug
	},

	_state: STATE_READY,
	_isMouseDownL: false,
	_isMouseDownM: false,
	_isMouseDownR: false,
	_suppressClick: false,
	_suppressContext: false,
	_shouldFireContext: false,	// [Linux]

	handleEvent: function FGH_handleEvent(event) {
		switch (event.type) {
			case "mousedown": 
				if (event.button == 0) {
					// suppress starting gesture on textboxes and textarea elements etc.
					var targetName = event.target.localName.toUpperCase();
					if (targetName == "INPUT" || targetName == "TEXTAREA") {
						log("*** ignore left-click on form element (" + targetName + ")");	// #debug
						break;
					}
					// supress starting gesture when dragging scrollbar
					targetName = event.originalTarget.localName;
					if (targetName == "scrollbarbutton" || targetName == "slider" || targetName == "thumb") {
						log("*** ignore left-click on scrollbar element (" + targetName + ")");	// #debug
						break;
					}
					this._isMouseDownL = true;
					if (!this._rockerGestureMiddleEnabled) {
						this._isMouseDownM = false;	// fixed invalid state of _isMouseDownM after autoscrolling
					}
					// any gestures with left-button - start
					if (this._triggerButton == 0 && !this._isMouseDownM && !this._isMouseDownR && !this._altKey(event)) {
						this._state = STATE_GESTURE;
						this._startGesture(event);
						// prevent selecting (only if mouse gesture is enabled)
						if (this._mouseGestureEnabled)
							event.preventDefault();
					}
					// rocker gestures
					else if (this._rockerGestureEnabled && this._isMouseDownR) {
						this._state = STATE_ROCKER;
						this._invokeExtraGesture(event, "rocker-left");
					}
					else if (this._rockerGestureMiddleEnabled && this._isMouseDownM) {
						this._state = STATE_ROCKER;
						this._invokeExtraGesture(event, "rocker-middle-left");
					}
				}
				else if (event.button == 1) {
					this._isMouseDownM = true;
					// any gestures with middle-button - start
					if (this._triggerButton == 1 && !this._isMouseDownL && !this._isMouseDownR && !this._altKey(event)) {
						this._state = STATE_GESTURE;
						this._startGesture(event);
						// prevent auto-scroll
						event.stopPropagation();
					}
					// rocker gestures
					else if (this._rockerGestureMiddleEnabled && this._isMouseDownL) {
						this._state = STATE_ROCKER;
						this._invokeExtraGesture(event, "rocker-left-middle");
					}
					else if (this._rockerGestureMiddleEnabled && this._isMouseDownR) {
							this._state = STATE_ROCKER;
							this._invokeExtraGesture(event, "rocker-right-middle");
					}
				}
				else if (event.button == 2) {
					// this fixes the problem: when showing context menu of a Flash movie, 
					// _isMouseDownR becomes true and then rocker-left will be fired with a left-click
					var targetName = event.target.localName.toUpperCase();
					if (targetName == "OBJECT" || targetName == "EMBED") {
						log("*** ignore right-click on flash movie (" + targetName + ")");	// #debug
						break;
					}
					this._isMouseDownR = true;
					if (!this._rockerGestureMiddleEnabled) {
						this._isMouseDownM = false;	// fixed invalid state of _isMouseDownM after autoscrolling
					}
					this._suppressContext = false;	// only time to reset _suppressContext flag
					this._enableContextMenu(true);
					// any gestures with right-button - start
					if (this._triggerButton == 2 && !this._isMouseDownL && !this._isMouseDownM && !this._altKey(event)) {
						this._state = STATE_GESTURE;
						this._startGesture(event);
					}
					// rocker gestures
					else if (this._rockerGestureEnabled && this._isMouseDownL) {
						this._state = STATE_ROCKER;
						this._invokeExtraGesture(event, "rocker-right");
					}
					else if (this._rockerGestureMiddleEnabled && this._isMouseDownM) {
						this._state = STATE_ROCKER;
						this._invokeExtraGesture(event, "rocker-middle-right");
					}
				}
				break;
			case "mousemove": 
				if (this._state == STATE_GESTURE || this._state == STATE_KEYPRESS) {
					if (this._mouseGestureEnabled) {
						// keypress gesture
						if (this._keypressGestureEnabled && (event.ctrlKey || event.shiftKey)) {
							var type = this._state == STATE_GESTURE ? "keypress-start" : "keypress-progress";
							this._state = STATE_KEYPRESS;
							this._invokeExtraGesture(event, type);
						}
						// mouse gesture
						this._progressGesture(event);
					}
				}
				else if (this._state == STATE_WHEEL || this._state == STATE_ROCKER) {
					// stop wheel gesture / rocker gesture when moving
					this._lastX = event.screenX;
					this._lastY = event.screenY;
					// #debug-begin
					var dx = this._lastX - this._lastExtraX;
					var dy = this._lastY - this._lastExtraY;
					log("moving in extra gesture: " + dx + " / " + dy);
					// #debug-end
					if (Math.abs(this._lastX - this._lastExtraX) > 10 || 
					    Math.abs(this._lastY - this._lastExtraY) > 10) {
						log("*** escape from " + (this._state == STATE_WHEEL ? "wheel gesture" : "rocker gesture"));	// #debug
						this._stopGesture();
					}
				}
				break;
			case "mouseup": 
				if (event.button == 0)
					this._isMouseDownL = false;
				else if (event.button == 1)
					this._isMouseDownM = false;
				else if (event.button == 2)
					this._isMouseDownR = false;
				// need additional | && this._state != STATE_READY| condition?
				if (!this._isMouseDownL && !this._isMouseDownM && !this._isMouseDownR) {
					// suppress clicks after releasing the last button in a rocker gesture
					if (this._state == STATE_ROCKER) {
						this._suppressClick = true;
					}
					// keypress gesture
					if (this._state == STATE_KEYPRESS) {
						this._state = STATE_READY;
						if (event.ctrlKey)
							this._invokeExtraGesture(event, "keypress-ctrl");
						else if (event.shiftKey)
							this._invokeExtraGesture(event, "keypress-shift");
						this._invokeExtraGesture(event, "keypress-stop");
					}
					// any gestures - stop
					this._stopGesture(event);
					// [Linux][Mac] display context menu artificially
					if (this._shouldFireContext) {
						this._shouldFireContext = false;
						this._displayContextMenu(event);
					}
				}
				break;
			case "contextmenu": 
				// [Linux] if right-click without holding left-button or middle-button, display context menu artificially
				if (this._isMouseDownR &&
					!this._isMouseDownL && (!this._rockerGestureMiddleEnabled || !this._isMouseDownM)) {
					// #debug-begin
					log("*** display context menu artificially");
					if (PLATFORM == "Windows_NT")
						alert("Assertion failed!\ndisplay context menu artificially");
					// #debug-end
					this._suppressContext = true;
					this._shouldFireContext = true;
				}
				// enable context menu if contextmenu event is fired by Application key.
				if (event.button == 0) {
					log("*** contextmenu with Application key");	// #debug
					this._enableContextMenu(true);
				}
				if (this._suppressContext) {
					this._suppressContext = false;
					event.preventDefault();
					event.stopPropagation();
					this._enableContextMenu(false);
				}
				break;
			case "DOMMouseScroll": 
				// (mouse|rocker|wheel) gesture > wheel gesture
				if (this._state == STATE_GESTURE || this._state == STATE_WHEEL || this._state == STATE_ROCKER) {
					this._state = STATE_WHEEL;
					this._invokeExtraGesture(event, event.detail < 0 ? "wheel-up" : "wheel-down");
					// suppress page scroll
					event.preventDefault();
					// required to suppress page scroll if using SmoothWheel or Yet Another Smooth Scrolling
					event.stopPropagation();
				}
				break;
			case "click": 
				// this fixes the bug: performing rocker-left on a link causes visiting the link
				// need 'if (this._isMouseDownL || this._isMouseDownR)' condition?
				if (this._state == STATE_ROCKER || this._suppressClick) {
					this._suppressClick = false;
					event.preventDefault();
					event.stopPropagation();
				}
				break;
			case "draggesture": 
				// this fixes the bug: _isMouseDownL remains true after drag-and-drop if...
				// STATE_READY  : trigger_button is right and mousegesture is enabled
				// STATE_GESTURE: trigger_button is left  and mousegesture is disabled
				// STATE_ROCKER : except draggesture events which are fired while sequential rocker-right
				if (this._state != STATE_ROCKER)
					this._isMouseDownL = false;
				break;
		}
		// #debug-begin
		if (event.type == "mousemove" && !this._isMouseDownL && !this._isMouseDownM && !this._isMouseDownR)
			return;
		log(
			(event.type + "    ").substr(0, 9) + "  " + 
			(this._isMouseDownL ? "L" : "_") + 
			(this._isMouseDownM ? "M" : "_") + 
			(this._isMouseDownR ? "R" : "_") + " " + 
			event.button + " (" + this._state + ") "+ (this._suppressContext ? "*" : "") + " [" + 
			this._directionChain + "]"
		);
		// #debug-end
	},

	_altKey: function(event) {
		return this._suppressAlt ? event.altKey : false;
	},

	_displayContextMenu: function FGH__displayContextMenu(event) {
		// this fixes the problem: the list of alternative words doesn't display in the context menu
		// when right-clicking on a misspelled word, because of a wrong value of |document.popupRangeOffset|.
		with (this._drawArea.ownerDocument.defaultView) {
			if (!nsContextMenu.prototype._setTargetInternal) {
				nsContextMenu.prototype._setTargetInternal = nsContextMenu.prototype.setTarget;
				nsContextMenu.prototype.setTarget = function(aNode, aRangeParent, aRangeOffset) {
					this._setTargetInternal(aNode, aRangeParent, this._rangeOffset);
				};
				log("*** REPLACED nsContextMenu.prototype.setTarget");	// #debug
			}
			nsContextMenu.prototype._rangeOffset = event.rangeOffset;
		}
		this._enableContextMenu(true);
		// open the context menu artificially
		var evt = event.originalTarget.ownerDocument.createEvent("MouseEvents");
		evt.initMouseEvent(
			"contextmenu", true, true, event.originalTarget.ownerDocument.defaultView, 0,
			event.screenX, event.screenY, event.clientX, event.clientY,
			false, false, false, false, 2, null
		);
		event.originalTarget.dispatchEvent(evt);
	},

	_enableContextMenu: function FGH__enableContextMenu(aEnable) {
		// [Firefox3.6] in view-source window
		// [Firefox4] in main window and view-source window
		// If 'dom.event.contextmenu.enabled' is false,
		// there is a problem that context menu is not suppressed
		// by preventDefault and stopPropagation for DOM contextmenu event.
		// So, we should set hidden="true" attribute temporarily.
		var elt = this._drawArea.ownerDocument.getElementById("contentAreaContextMenu");
		if (!elt)
			elt = this._drawArea.ownerDocument.getElementById("viewSourceContextMenu");
		if (!elt)
			return;
		if (aEnable)
			elt.removeAttribute("hidden");
		else
			elt.setAttribute("hidden", "true");
	},

	_wheelOnTabBar: function FGH__wheelOnTabBar(event) {
		var tabbar = null;
		if (event.target.localName == "tab")
			tabbar = event.target.parentNode;
		else if (event.target.localName == "tabs" && event.originalTarget.localName != "menuitem")
			tabbar = event.target;
		else
			return;
		event.preventDefault();
		event.stopPropagation();
		tabbar.advanceSelectedTab(event.detail < 0 ? -1 : 1, true);
	},

	// called from handleEvent (type is "mousedown")
	_startGesture: function FGH__startGesture(event) {
		log("_startGesture()");	// #debug
		this.sourceNode = event.target;
		this._lastX = event.screenX;
		this._lastY = event.screenY;
		this._directionChain = "";
		this._shouldFireContext = false;
		// trail drawing
		if (this._trailEnabled)
			this.createTrail(event);
	},

	// called from handleEvent (type is "mousemove")
	_progressGesture: function FGH__progressGesture(event) {
		var x = event.screenX;
		var y = event.screenY;
		var dx = Math.abs(x - this._lastX);
		var dy = Math.abs(y - this._lastY);
		// ignore minimal mouse movement
		if (dx < 10 && dy < 10)
			return;
		// current direction
		var direction;
		if (dx > dy)
			direction = x < this._lastX ? "L" : "R";
		else
			direction = y < this._lastY ? "U" : "D";
		// trail drawing
		if (this._trailEnabled)
			this.drawTrail(this._lastX, this._lastY, x, y);
		// remember the current position
		this._lastX = x;
		this._lastY = y;
		// don't fire onDirectionChange while performing keypress gesture
		if (this._state == STATE_KEYPRESS)
			return;
		// compare to the last direction
		var lastDirection = this._directionChain.charAt(this._directionChain.length - 1);
		if (direction != lastDirection) {
			this._directionChain += direction;
			this._gestureObserver.onDirectionChanged(event, this._directionChain);
		}
		if (this._gestureTimeout > 0)
			this._setTimeout(this._gestureTimeout);
	},

	// called from handleEvent (type is "mousedown", "mousemove", "DOMMouseScroll", "click")
	_invokeExtraGesture: function FGH__invokeExtraGesture(event, aGestureType) {
		log("_invokeExtraGesture(" + aGestureType + ", _state = " + this._state + ")");	// #debug
		// @see EscapeFromWheelGestureFx3.diff
		if (this._state == STATE_WHEEL || this._state == STATE_ROCKER) {
			this._lastExtraX = event.screenX;
			this._lastExtraY = event.screenY;
		}
		// clear trail drawing when invoking extra gesture except keypress gesture
		if (this._state != STATE_KEYPRESS && this._trailEnabled)
			this.eraseTrail();
		// Fixed bug: FireGestures.sourceNode is null when doing rocker-right
		if (!this.sourceNode)
			this.sourceNode = event.target;
		this._gestureObserver.onExtraGesture(event, aGestureType);
		this._suppressContext = true;
		this._shouldFireContext = false;
		this._directionChain = "";
		// set timer for invalid wheel gesture / rocker gesture
		if (this._state == STATE_WHEEL || this._state == STATE_ROCKER) {
			if (this._gestureTimeout > 0)
				this._setTimeout(this._gestureTimeout);
		}
	},

	// called from handleEvent (type is "mousemove" or "mouseup"), notify, openPopupAtPointer
	_stopGesture: function FGH__stopGesture(event) {
		log("_stopGesture(" + this._directionChain + ")");	// #debug
		this._state = STATE_READY;
		this._isMouseDownL = false;
		this._isMouseDownM = false;
		this._isMouseDownR = false;
		// clear trail drawing
		if (this._trailEnabled)
			this.eraseTrail();
		// don't call onMouseGesture after events sequence: mousedown > minimal mousemove > mouseup
		if (this._directionChain) {
			this._gestureObserver.onMouseGesture(event, this._directionChain);
			// suppress immediate context menu after finishing mouse gesture with right-button
			// don't suppress mouse gesture with left or middle button
			this._suppressContext = true;
			this._shouldFireContext = false;
		}
		this.sourceNode = null;
		this._directionChain = "";
		this._clearTimeout();
	},


	/* ::::: nsIObserver ::::: */

	observe: function FGH_observe(aSubject, aTopic, aData) {
		// log("observe(" + aSubject + ", " + aTopic + ", " + aData + ")");	// #debug
		if (aTopic == "nsPref:changed")
			this._reloadPrefs();
	},


	/* ::::: nsITimerCallback ::::: */

	_gestureTimer: null,

	// start timer for gesture timeout
	_setTimeout: function FGH__setTimeout(aMsec) {
		this._clearTimeout();
		this._gestureTimer = Cc["@mozilla.org/timer;1"].createInstance(Ci.nsITimer);
		this._gestureTimer.initWithCallback(this, aMsec, Ci.nsITimer.TYPE_ONE_SHOT);
	},

	// stop timer for gesture timeout
	_clearTimeout: function FGH__clearTimeout() {
		if (this._gestureTimer) {
			this._gestureTimer.cancel();
			this._gestureTimer = null;
		}
	},

	notify: function(aTimer) {
		log("gesture-timeout");	// #debug
		this._suppressContext = true;
		this._shouldFireContext = false;
		this._directionChain = "";
		this._stopGesture();
		this._gestureObserver.onExtraGesture(null, "gesture-timeout");
	},

	openPopupAtPointer: function FGH_openPopupAtPointer(aPopup) {
		aPopup.openPopupAtScreen(this._lastX, this._lastY, false);
		// stop gesture
		this._directionChain = "";
		// _stopGesture is called twice when popup is open from wheel gesture,
		// but this is required to initialize flags and free memory
		this._stopGesture();
	},


	/* ::::: MOUSE TRAIL ::::: */

	_trailDot: null,
	_trailArea: null,
	_trailLastDot: null,
	_trailOffsetX: 0,
	_trailOffsetY: 0,
	_trailZoom: 1,

	// called from _startGesture
	createTrail: function FGH_createTrail(event) {
		var doc;
		if (event.view.top.document instanceof Ci.nsIDOMHTMLDocument)
			doc = event.view.top.document;
		else if (event.view.document instanceof Ci.nsIDOMHTMLDocument)
			doc = event.view.document;
		else
			return;
		var insertionNode = doc.documentElement ? doc.documentElement : doc;
		if (doc.getBoxObjectFor) {
			// [Firefox3.5]
			var box = doc.getBoxObjectFor(insertionNode);
			this._trailOffsetX = box.screenX;
			this._trailOffsetY = box.screenY;
			this._trailZoom = 1;
			var tabbrowser = this._drawArea.ownerDocument.defaultView.gBrowser;
			// gesture_mappings  : gBrowser is a xul:tabbrowser element
			// viewsource_mapping: gBrowser is a xul:browser element
			if (tabbrowser && (tabbrowser.mCurrentBrowser || tabbrowser).markupDocumentViewer.fullZoom != 1) {
				// get the zoom factor which is more accurate than nsIMarkupDocumentViewer.fullZoom
				var dot = doc.createElementNS(HTML_NS, "xdTrailDot");
				dot.style.top = "1048576px";	// arbitrary large value
				dot.style.position = "absolute";
				insertionNode.appendChild(dot);
				this._trailZoom = (doc.getBoxObjectFor(dot).screenY - this._trailOffsetY) / dot.offsetTop;
				insertionNode.removeChild(dot);
			}
		}
		else {
			// [Firefox3.6]
			var win = doc.defaultView;
			this._trailZoom = win.QueryInterface(Ci.nsIInterfaceRequestor).
			                  getInterface(Ci.nsIDOMWindowUtils).screenPixelsPerCSSPixel;
			this._trailOffsetX = (win.mozInnerScreenX - win.scrollX) * this._trailZoom;
			this._trailOffsetY = (win.mozInnerScreenY - win.scrollY) * this._trailZoom;
		}
		if (this._trailZoom != 1) log("_trailZoom: " + this._trailZoom);	// #debug
		this._trailArea = doc.createElementNS(HTML_NS, "xdTrailArea");
		insertionNode.appendChild(this._trailArea);
		this._trailDot = doc.createElementNS(HTML_NS, "xdTrailDot");
		this._trailDot.style.width = this._trailSize + "px";
		this._trailDot.style.height = this._trailSize + "px";
		this._trailDot.style.background = this._trailColor;
		this._trailDot.style.border = "0px";
		this._trailDot.style.position = "absolute";
		this._trailDot.style.zIndex = 2147483647;
	},

	// called from _progressGesture
	drawTrail: function FGH_drawTrail(x1, y1, x2, y2) {
		if (!this._trailArea)
			return;
		var xMove = x2 - x1;
		var yMove = y2 - y1;
		var xDecrement = xMove < 0 ? 1 : -1;
		var yDecrement = yMove < 0 ? 1 : -1;
		x2 -= this._trailOffsetX;
		y2 -= this._trailOffsetY;
		if (Math.abs(xMove) >= Math.abs(yMove))
			for (var i = xMove; i != 0; i += xDecrement)
				this._strokeDot(x2 - i, y2 - Math.round(yMove * i / xMove));
		else
			for (var i = yMove; i != 0; i += yDecrement)
				this._strokeDot(x2 - Math.round(xMove * i / yMove), y2 - i);
	},

	// called from _stopGesture
	eraseTrail: function FGH_eraseTrail() {
		if (this._trailArea && this._trailArea.parentNode) {
			while (this._trailArea.lastChild)
				this._trailArea.removeChild(this._trailArea.lastChild);
			this._trailArea.parentNode.removeChild(this._trailArea);
		}
		this._trailDot = null;
		this._trailArea = null;
		this._trailLastDot = null;
	},

	// called from drawTrail
	_strokeDot: function FGH__strokeDot(x, y) {
		if (this._trailArea.y == y && this._trailArea.h == this._trailSize) {
			// draw vertical line
			var newX = Math.min(this._trailArea.x, x);
			var newW = Math.max(this._trailArea.x + this._trailArea.w, x + this._trailSize) - newX;
			this._trailArea.x = newX;
			this._trailArea.w = newW;
			this._trailLastDot.style.left  = newX.toString() + "px";
			this._trailLastDot.style.width = newW.toString() + "px";
			return;
		}
		else if (this._trailArea.x == x && this._trailArea.w == this._trailSize) {
			// draw horizontal line
			var newY = Math.min(this._trailArea.y, y);
			var newH = Math.max(this._trailArea.y + this._trailArea.h, y + this._trailSize) - newY;
			this._trailArea.y = newY;
			this._trailArea.h = newH;
			this._trailLastDot.style.top    = newY.toString() + "px";
			this._trailLastDot.style.height = newH.toString() + "px";
			return;
		}
		if (this._trailZoom != 1) {
			x = Math.floor(x / this._trailZoom);
			y = Math.floor(y / this._trailZoom);
		}
		var dot = this._trailDot.cloneNode(true);
		dot.style.left = x + "px";
		dot.style.top = y + "px";
		this._trailArea.x = x;
		this._trailArea.y = y;
		this._trailArea.w = this._trailSize;
		this._trailArea.h = this._trailSize;
		this._trailArea.appendChild(dot);
		this._trailLastDot = dot;
		// log("_strokeDot(" + x + ", " + y + ")");	// #debug
		// dot.style.outline = "1px solid blue";	// #debug
	},

};


////////////////////////////////////////////////////////////////////////////////
// XPCOM registration

if (XPCOMUtils.generateNSGetFactory)
	// [Firefox4]
	var NSGetFactory = XPCOMUtils.generateNSGetFactory([xdGestureHandler]);
else
	// [Firefox3.6]
	var NSGetModule = XPCOMUtils.generateNSGetModule([xdGestureHandler]);


