document.addEventListener('DOMContentLoaded', function() {
    loadServices();
    const searchInput = document.getElementById('serviceSearch');
    if (searchInput) {
        searchInput.addEventListener('input', filterServices);
    }
    // Event delegation for book buttons
    document.getElementById('servicesContainer').addEventListener('click', function(e) {
        const btn = e.target.closest('.btn-book');
        if (!btn) return;
        const name = btn.getAttribute('data-name');
        const price = btn.getAttribute('data-price');
        window.location.href = 'payment.html?name=' + encodeURIComponent(name) + '&price=' + price;
    });
});

let allServices = [];

async function loadServices() {
    const container = document.getElementById('servicesContainer');
    if (!container) return;
    
    try {
        const resp = await fetch('/api/services');
        allServices = await resp.json();
        renderServices(allServices);
    } catch (e) {
        container.innerHTML = '<p class="loading">Не удалось загрузить услуги. Пожалуйста, попробуйте позже.</p>';
    }
}

function renderServices(categories) {
    const container = document.getElementById('servicesContainer');
    container.innerHTML = '';
    
    categories.forEach((cat) => {
        const block = document.createElement('div');
        block.className = 'category-block';
        block.setAttribute('data-category', cat.display);
        
        const title = document.createElement('div');
        title.className = 'category-title';
        title.innerHTML = `<span>${cat.display}</span><span class="toggle">▼</span>`;
        title.onclick = function() {
            const content = this.nextElementSibling;
            const toggle = this.querySelector('.toggle');
            if (content.classList.contains('hidden')) {
                content.classList.remove('hidden');
                toggle.textContent = '▼';
            } else {
                content.classList.add('hidden');
                toggle.textContent = '▲';
            }
        };
        block.appendChild(title);
        
        const content = document.createElement('div');
        
        cat.subcategories.forEach((sub) => {
            if (sub.name) {
                const subTitle = document.createElement('div');
                subTitle.className = 'subcategory-title';
                subTitle.textContent = sub.name;
                content.appendChild(subTitle);
            }
            
            const table = document.createElement('table');
            table.className = 'service-table';
            sub.services.forEach(svc => {
                const row = table.insertRow();
                row.innerHTML = `
                    <td class="service-name">${svc.name}</td>
                    <td class="service-price">${svc.price.toLocaleString('ru-RU')} ₽</td>
                    <td class="service-action">
                        <button class="btn-book" data-name="${svc.name.replace(/"/g, '&quot;')}" data-price="${svc.price}">
                            Записаться
                        </button>
                    </td>`;
            });
            content.appendChild(table);
        });
        
        block.appendChild(content);
        container.appendChild(block);
    });
}

function filterServices() {
    const query = document.getElementById('serviceSearch').value.toLowerCase().trim();
    if (!query) {
        renderServices(allServices);
        return;
    }
    
    const filtered = allServices.map(cat => {
        const filteredSubs = cat.subcategories.map(sub => {
            const filteredSvcs = sub.services.filter(s => 
                s.name.toLowerCase().includes(query)
            );
            return { ...sub, services: filteredSvcs };
        }).filter(sub => sub.services.length > 0);
        return { ...cat, subcategories: filteredSubs };
    }).filter(cat => cat.subcategories.length > 0);
    
    renderServices(filtered);
}