const Task = require('./task');
const {TaskName, TaskPreconditions} = require('../utils/constants');

class TaskPlay extends Task {
  constructor(logger, opts) {
    super(logger, opts);
    this.preconditions = TaskPreconditions.Endpoint;

    this.url = this.data.url;
    this.loop = this.data.loop || 1;
    this.earlyMedia = this.data.earlyMedia === true;
  }

  get name() { return TaskName.Play; }

  async exec(cs, ep) {
    await super.exec(cs);
    this.ep = ep;
    try {
      while (!this.killed && (this.loop === 'forever' || this.loop--) && this.ep.connected) {
        if (cs.isInConference) {
          const {memberId, confName, confUuid} = cs;
          await this.playToConfMember(this.ep, memberId, confName, confUuid, this.url);
        }
        else await ep.play(this.url);
      }
    } catch (err) {
      this.logger.info(err, `TaskPlay:exec - error playing ${this.url}`);
    }
    this.emit('playDone');
  }

  async kill(cs) {
    super.kill(cs);
    if (this.ep.connected && !this.playComplete) {
      this.logger.debug('TaskPlay:kill - killing audio');
      if (cs.isInConference) {
        const {memberId, confName} = cs;
        this.killPlayToConfMember(this.ep, memberId, confName);
      }
      else {
        await this.ep.api('uuid_break', this.ep.uuid).catch((err) => this.logger.info(err, 'Error killing audio'));
      }
    }
  }
}

module.exports = TaskPlay;
