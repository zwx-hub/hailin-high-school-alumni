const toggle = document.querySelector('.menu-toggle');
const nav = document.querySelector('#primary-nav');

if (toggle && nav) {
  toggle.addEventListener('click', () => {
    const open = nav.classList.toggle('is-open');
    toggle.setAttribute('aria-expanded', String(open));
  });

  nav.addEventListener('click', (event) => {
    if (event.target.matches('a')) {
      nav.classList.remove('is-open');
      toggle.setAttribute('aria-expanded', 'false');
    }
  });
}

const form = document.querySelector('.join-form');
if (form) {
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    alert('登记信息已模拟提交。正式上线时请接入后端接口或表单服务。');
  });
}
