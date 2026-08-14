(function (root) {
  const READY = 'READY';
  const SUBMITTING = 'SUBMITTING';
  const AWAITING_NEXT = 'AWAITING_NEXT';

  function createCheckinGateController() {
    let currentState = READY;

    return {
      state() {
        return currentState;
      },
      begin() {
        if (currentState !== READY) return false;
        currentState = SUBMITTING;
        return true;
      },
      complete() {
        if (currentState === SUBMITTING) {
          currentState = AWAITING_NEXT;
        }
      },
      reset() {
        currentState = READY;
      }
    };
  }

  root.CheckinGate = {
    create: createCheckinGateController
  };
})(window);