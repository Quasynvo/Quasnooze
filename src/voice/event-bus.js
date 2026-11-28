/**
 * Central event bus for voice features that handles both TTS streaming and barge-in events
 * through a unified interface. This reduces complexity by centralizing voice event handling
 * and allows for better coordination between voice features.
 */

class VoiceEventBus {
  constructor() {
    this.listeners = new Map();
    this.eventHistory = [];
  }

  /**
   * Subscribe to a specific event type
   * @param {string} eventType - Type of event to listen for
   * @param {Function} callback - Function to call when event occurs
   * @returns {Function} - Unsubscribe function
   */
  on(eventType, callback) {
    if (!this.listeners.has(eventType)) {
      this.listeners.set(eventType, new Set());
    }
    this.listeners.get(eventType).add(callback);
    
    return () => {
      const callbacks = this.listeners.get(eventType);
      if (callbacks) {
        callbacks.delete(callback);
      }
    };
  }

  /**
   * Emit an event to all subscribers
   * @param {string} eventType - Type of event
   * @param {Object} data - Event data
   */
  emit(eventType, data) {
    const event = {
      type: eventType,
      timestamp: performance.now(),
      data
    };
    
    this.eventHistory.push(event);
    
    const callbacks = this.listeners.get(eventType);
    if (callbacks) {
      callbacks.forEach(callback => {
        try {
          callback(event);
        } catch (error) {
          console.error(`Error in voice event handler for ${eventType}:`, error);
        }
      });
    }
  }

  /**
   * Get the most recent event of a specific type
   * @param {string} eventType - Type of event
   * @returns {Object|null} - Most recent event or null if none
   */
  getLastEvent(eventType) {
    return this.eventHistory
      .filter(event => event.type === eventType)
      .pop() || null;
  }

  /**
   * Clear event history
   */
  clearHistory() {
    this.eventHistory = [];
  }
}

// Export a singleton instance
export const voiceEventBus = new VoiceEventBus();
