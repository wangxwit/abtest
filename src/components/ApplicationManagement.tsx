import type { Experiment } from '../data';
import ServiceCenter from './ServiceCenter';
import './application-management.css';

export default function ApplicationManagement({experiments,onOpen}:{experiments:Experiment[];onOpen:(experiment:Experiment)=>void}) {
  return <div className="am-page">
    <div className="page-heading simple"><div><h1>应用管理</h1><p>以应用／服务为入口，统一维护参数、标签与各环境的接入配置。</p></div></div>
    <ServiceCenter embedded experiments={experiments} onOpen={onOpen}/>
  </div>;
}
